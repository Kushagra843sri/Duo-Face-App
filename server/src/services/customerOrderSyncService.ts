import { z } from 'zod';

import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import { CustomerAppUnavailableError } from '../integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreOrderSyncStore } from '../integrations/firebase/FirestoreOrderSyncStore';
import type { OrderSyncStore } from '../integrations/firebase/FirestoreOrderSyncStore';
import { MAX_SYNC_ATTEMPTS, orderSyncRecordSchema } from '../types/orderSync';
import type { OrderSyncErrorCategory, OrderSyncRecord } from '../types/orderSync';

export type SyncResult =
  | 'completed' // out_for_delivery -> delivered was written now
  | 'already_delivered' // nothing written (idempotent success)
  | 'already_completed' // a previous run finished; nothing done
  | 'protected_status' // cancelled / rejected / any other status: never overwritten
  | 'not_found'
  | 'shop_mismatch'
  | 'transient_external_failure' // still failing after this run's bounded retries
  | 'permanent_external_failure'
  | 'max_attempts_reached';

/** Immediate retries per run for transient failures (initial try + 2 retries). */
export const IMMEDIATE_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = [500, 2000];
const SWEEP_LIMIT = 50;

const orderStatusViewSchema = z.object({ orderId: z.string(), shopId: z.string(), status: z.string() });

const RETRYABLE: ReadonlySet<OrderSyncErrorCategory> = new Set(['transient_external_failure']);

/**
 * The ONLY Duo-Face code that writes a Customer App order's status
 * (docs/decisions/024). One business operation, `syncDelivered`; the target
 * status is fixed, so there is no way to request another. Duo-Face's own
 * assignment state is never rolled back by anything that happens here.
 *
 * Logs contain orderId + a result/category only — never order contents,
 * addresses, phone numbers, payment data, tokens or raw errors.
 */
export class CustomerOrderSyncService {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly store: OrderSyncStore = new FirestoreOrderSyncStore(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => Date = () => new Date(),
    /**
     * For restart recovery: is there a `delivered` Duo-Face assignment for
     * this order in this shop? A record alone never justifies a Customer App write.
     */
    private readonly isAssignmentDelivered: (orderId: string, customerAppShopId: string) => Promise<boolean> = async () => false
  ) {}

  /**
   * Idempotent, bounded. Call after the Duo-Face assignment is `delivered`
   * (never inside a Duo-Face transaction). Never throws for external
   * problems; the result and the durable record describe what happened.
   */
  async syncDelivered(orderId: string, customerAppShopId: string): Promise<SyncResult> {
    const existing = await this.loadRecord(orderId);

    if (existing?.state === 'completed') return 'already_completed';
    if (existing?.state === 'failed' && existing.lastErrorCategory && !RETRYABLE.has(existing.lastErrorCategory)) {
      return existing.lastErrorCategory as SyncResult; // same category names; permanent, never re-attempted
    }

    let attempts = existing?.attempts ?? 0;
    const createdAt = existing?.createdAt ?? this.now();

    for (let run = 0; run < IMMEDIATE_ATTEMPTS; run++) {
      if (attempts >= MAX_SYNC_ATTEMPTS) return 'max_attempts_reached';
      attempts += 1;
      const attemptedAt = this.now();

      const outcome = await this.attempt(orderId, customerAppShopId);

      if (outcome.kind === 'transient') {
        // Not final: keep it retryable, then back off (never while holding any transaction).
        await this.save(orderId, { state: 'failed', attempts, attemptedAt, createdAt, error: 'transient_external_failure' });
        if (run < IMMEDIATE_ATTEMPTS - 1 && attempts < MAX_SYNC_ATTEMPTS) {
          await this.sleep(RETRY_BACKOFF_MS[Math.min(run, RETRY_BACKOFF_MS.length - 1)]);
          continue;
        }
        console.warn(`CustomerOrderSyncService: order ${orderId} sync still failing (transient_external_failure), attempt ${attempts}`);
        return 'transient_external_failure';
      }

      if (outcome.kind === 'done') {
        await this.save(orderId, { state: 'completed', attempts, attemptedAt, createdAt, outcome: outcome.result === 'completed' ? 'delivered' : 'already_delivered' });
        return outcome.result;
      }

      // Permanent / protected: recorded, never retried, never overwritten.
      await this.save(orderId, { state: 'failed', attempts, attemptedAt, createdAt, error: outcome.category });
      console.warn(`CustomerOrderSyncService: order ${orderId} not synchronized (${outcome.category})`);
      return outcome.category;
    }

    return 'transient_external_failure';
  }

  /** One verify-then-atomic-write pass. */
  private async attempt(
    orderId: string,
    shopId: string
  ): Promise<
    | { kind: 'done'; result: 'completed' | 'already_delivered' }
    | { kind: 'transient' }
    | { kind: 'permanent'; category: 'protected_status' | 'not_found' | 'shop_mismatch' | 'permanent_external_failure' }
  > {
    try {
      // 1) Verify before writing (fast, no transaction).
      const raw = await this.orders.getOrderById(orderId);
      if (!raw) return { kind: 'permanent', category: 'not_found' };
      const view = orderStatusViewSchema.safeParse(raw);
      if (!view.success || view.data.orderId !== orderId) return { kind: 'permanent', category: 'protected_status' };
      if (view.data.shopId !== shopId) return { kind: 'permanent', category: 'shop_mismatch' };
      if (view.data.status === 'delivered') return { kind: 'done', result: 'already_delivered' };
      if (view.data.status !== 'out_for_delivery') return { kind: 'permanent', category: 'protected_status' };

      // 2) The provider re-checks the status inside a transaction and writes only `status`.
      const outcome = await this.orders.markOrderDelivered(orderId, shopId);
      switch (outcome.kind) {
        case 'completed':
          return { kind: 'done', result: 'completed' };
        case 'already_delivered':
          return { kind: 'done', result: 'already_delivered' };
        case 'protected_status':
          return { kind: 'permanent', category: 'protected_status' };
        case 'not_found':
          return { kind: 'permanent', category: 'not_found' };
        case 'shop_mismatch':
          return { kind: 'permanent', category: 'shop_mismatch' };
      }
    } catch (err) {
      if (err instanceof CustomerAppUnavailableError && err.category === 'permanent') {
        return { kind: 'permanent', category: 'permanent_external_failure' };
      }
      return { kind: 'transient' }; // unknown errors are retried, boundedly
    }
  }

  /**
   * Restart recovery. Re-attempts records left `pending`, or `failed` with a
   * retryable category and attempts remaining. There is no worker: this runs
   * once at startup (server.ts) and can be called from a future scheduler.
   * @returns number of records it tried to synchronize
   */
  async retryOutstanding(limit: number = SWEEP_LIMIT): Promise<number> {
    let processed = 0;
    const raw = await this.store.listByStates(['pending', 'failed'], limit);

    for (const doc of raw) {
      const parsed = orderSyncRecordSchema.safeParse(doc);
      if (!parsed.success) continue;
      const record = parsed.data;
      if (record.attempts >= MAX_SYNC_ATTEMPTS) continue;
      if (record.state === 'failed' && !(record.lastErrorCategory && RETRYABLE.has(record.lastErrorCategory))) continue;

      try {
        const order = orderStatusViewSchema.safeParse(await this.orders.getOrderById(record.orderId));
        if (!order.success) continue; // unreadable now; leave the record for a later sweep
        if (!(await this.isAssignmentDelivered(record.orderId, order.data.shopId))) continue;
        await this.syncDelivered(record.orderId, order.data.shopId);
        processed += 1;
      } catch {
        console.warn(`CustomerOrderSyncService: sweep skipped order ${record.orderId}`);
      }
    }
    return processed;
  }

  private async loadRecord(orderId: string): Promise<OrderSyncRecord | null> {
    const raw = await this.store.get(orderId);
    if (!raw) return null;
    const parsed = orderSyncRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null; // a malformed record is replaced by the next save
  }

  private async save(
    orderId: string,
    fields: {
      state: 'completed' | 'failed';
      attempts: number;
      attemptedAt: Date;
      createdAt: unknown;
      error?: OrderSyncErrorCategory;
      outcome?: 'delivered' | 'already_delivered';
    }
  ): Promise<void> {
    const now = this.now();
    await this.store.set(orderId, {
      orderId,
      targetStatus: 'delivered',
      state: fields.state,
      attempts: fields.attempts,
      lastAttemptAt: fields.attemptedAt,
      ...(fields.state === 'completed' ? { completedAt: now, outcome: fields.outcome } : {}),
      ...(fields.error ? { lastErrorCategory: fields.error } : {}),
      createdAt: fields.createdAt,
      updatedAt: now,
    });
  }
}
