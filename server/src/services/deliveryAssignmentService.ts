import { randomUUID } from 'crypto';

import { z } from 'zod';

import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { ActiveAssignmentConflictError, FirestoreDeliveryAssignmentStore } from '../integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryAssignmentStore } from '../integrations/firebase/FirestoreDeliveryAssignmentStore';
import { AppError } from '../middleware/errorHandler';
import { DriverService } from './driverService';
import { deliveryEventHub } from '../realtime/deliveryEvents';
import type { DeliveryEventPublisher } from '../realtime/deliveryEvents';
import { toCustomerStatus } from './customerTrackingStatus';
import { loadDeliveryOtpSecret } from '../config/deliveryOtp';
import { deliveryCodeTriggerHub } from './deliveryCodeTrigger';
import type { DeliveryCodeTrigger } from './deliveryCodeTrigger';
import { DeliveryOtp, MAX_OTP_ATTEMPTS } from './deliveryOtp';
import { dispatchTriggerHub } from './dispatchTrigger';
import type { DispatchTrigger } from './dispatchTrigger';
import { deliveryLifecycleEffectsHub } from './deliveryLifecycleEffects';
import type { DeliveryLifecycleEffects } from './deliveryLifecycleEffects';
import { TIMESTAMP_FIELD_BY_STATUS, isValidTransition } from './deliveryAssignmentTransitions';
import { customerAppOrderSnapshotSchema } from '../types/customerAppOrder';
import { deliveryAssignmentSchema } from '../types/deliveryAssignment';
import { buildPendingOrderSyncRecord, ORDER_SYNC_COLLECTION } from '../types/orderSync';
import type { DeliveryAssignment, DeliveryAssignmentStatus } from '../types/deliveryAssignment';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import type { DuoFaceShop } from '../types/duoFaceShop';
import type { MerchantDeliveryAssignment, MerchantOrderDeliveryAssignment } from '../types/merchantDelivery';

const assignDriverInputSchema = z.object({
  orderId: z.string().min(1),
  customerAppShopId: z.string().min(1),
  driverId: z.string().min(1),
});

export type AssignDriverInput = z.infer<typeof assignDriverInputSchema>;

// An order can only be actively assigned to one driver at a time.
// 'rejected'/'delivered'/'cancelled' are terminal and don't block a new assignment.
export const ACTIVE_ASSIGNMENT_STATUSES = ['assigned', 'accepted', 'picked_up'];
const ACTIVE_STATUSES = ACTIVE_ASSIGNMENT_STATUSES;

/** How long a driver has to answer an offer before it moves on to the next-nearest driver. */
export const OFFER_TTL_MS = 2 * 60 * 1000;

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

/**
 * Driver-facing serialization: same fields as the stored assignment, but
 * with timestamps as ISO 8601 strings (a raw Firestore Timestamp would
 * otherwise serialize as {_seconds,_nanoseconds}).
 */
export function toDriverAssignmentDto(assignment: DeliveryAssignment) {
  const iso = (value: unknown) => toIsoString(value) ?? undefined;
  return {
    assignmentId: assignment.assignmentId,
    orderId: assignment.orderId,
    customerAppShopId: assignment.customerAppShopId,
    driverId: assignment.driverId,
    status: assignment.status,
    assignedAt: iso(assignment.assignedAt),
    acceptedAt: iso(assignment.acceptedAt),
    rejectedAt: iso(assignment.rejectedAt),
    pickedUpAt: iso(assignment.pickedUpAt),
    deliveredAt: iso(assignment.deliveredAt),
    cancelledAt: iso(assignment.cancelledAt),
    createdAt: iso(assignment.createdAt),
    updatedAt: iso(assignment.updatedAt),
  };
}

function optionalIso(value: unknown): string | undefined {
  return toIsoString(value) ?? undefined;
}

function toMerchantDto(assignment: DeliveryAssignment, driver: DuoFaceDriver | null): MerchantDeliveryAssignment {
  const acceptedAt = optionalIso(assignment.acceptedAt);
  const rejectedAt = optionalIso(assignment.rejectedAt);
  const pickedUpAt = optionalIso(assignment.pickedUpAt);
  const deliveredAt = optionalIso(assignment.deliveredAt);
  const cancelledAt = optionalIso(assignment.cancelledAt);
  return {
    assignmentId: assignment.assignmentId,
    orderId: assignment.orderId,
    customerAppShopId: assignment.customerAppShopId,
    driverId: assignment.driverId,
    driverName: driver?.name ?? null,
    ...(driver?.phoneNumber ? { driverPhoneNumber: driver.phoneNumber } : {}),
    status: assignment.status,
    assignedAt: toIsoString(assignment.assignedAt),
    ...(acceptedAt ? { acceptedAt } : {}),
    ...(rejectedAt ? { rejectedAt } : {}),
    ...(pickedUpAt ? { pickedUpAt } : {}),
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(cancelledAt ? { cancelledAt } : {}),
    createdAt: toIsoString(assignment.createdAt),
    updatedAt: toIsoString(assignment.updatedAt),
  };
}

function createDeliveryOtpFromEnv(): DeliveryOtp | null {
  const secret = loadDeliveryOtpSecret();
  return secret ? new DeliveryOtp(secret) : null;
}

export class DeliveryAssignmentService {
  constructor(
    private readonly store: DeliveryAssignmentStore = new FirestoreDeliveryAssignmentStore(),
    private readonly driverService: DriverService = new DriverService(),
    private readonly orderProvider: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly events: DeliveryEventPublisher = deliveryEventHub,
    private readonly effects: DeliveryLifecycleEffects = deliveryLifecycleEffectsHub,
    private readonly dispatch: DispatchTrigger = dispatchTriggerHub,
    private readonly now: () => Date = () => new Date(),
    private readonly otp: DeliveryOtp | null = createDeliveryOtpFromEnv(),
    private readonly codes: DeliveryCodeTrigger = deliveryCodeTriggerHub
  ) {}

  /**
   * Called both as a domain operation and, as of Phase 13, from
   * POST /merchant/deliveries. Every precondition is verified server-side;
   * nothing here trusts a caller-supplied shopId/driverId without checking
   * it. Rejections use AppError so a route can surface the right status
   * code via the existing errorHandler.
   */
  async assignDriver(input: AssignDriverInput): Promise<DeliveryAssignment> {
    const parsed = assignDriverInputSchema.parse(input);

    const rawOrder = await this.orderProvider.getOrderById(parsed.orderId);
    // Missing order and "order belongs to a different shop" collapse to the
    // same 404 — never reveal another shop's order even to a merchant who
    // already knows/guesses a valid orderId (same rule as docs/decisions/011).
    if (!rawOrder) {
      throw new AppError(404, 'Order not found.');
    }
    const order = customerAppOrderSnapshotSchema.parse(rawOrder);
    if (order.shopId !== parsed.customerAppShopId) {
      throw new AppError(404, 'Order not found.');
    }

    const driver = await this.driverService.getById(parsed.driverId);
    if (!driver) {
      throw new AppError(404, 'Driver not found.');
    }
    if (driver.status !== 'active') {
      throw new AppError(409, 'Driver is not active.');
    }

    const assignmentId = randomUUID();
    const now = this.now();
    const data: Record<string, unknown> = {
      assignmentId,
      orderId: parsed.orderId,
      customerAppShopId: parsed.customerAppShopId,
      driverId: parsed.driverId,
      status: 'assigned',
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.store.createIfNoActiveAssignmentForOrder(assignmentId, parsed.orderId, ACTIVE_STATUSES, data);
    } catch (err) {
      if (err instanceof ActiveAssignmentConflictError) {
        throw new AppError(409, `Order ${parsed.orderId} already has an active delivery assignment.`);
      }
      throw err;
    }
    const created = deliveryAssignmentSchema.parse(data);
    this.runEffect(() => this.effects.onAssigned(created));
    return created;
  }

  /**
   * Post-commit side effects run in the background: their failure or latency
   * never reaches the caller and never rolls anything back.
   */
  private runEffect(effect: () => Promise<void>): void {
    try {
      void effect().catch(() => console.warn('DeliveryAssignmentService: a lifecycle side effect failed'));
    } catch {
      console.warn('DeliveryAssignmentService: a lifecycle side effect failed');
    }
  }

  /**
   * Unlike listByDriverId, a malformed document here is a hard failure
   * (thrown, not skipped) — this is a specific single assignment being
   * requested, so silently treating it as "not found" would be misleading.
   * Mirrors MerchantOrderService.getOrder.
   */
  async getById(assignmentId: string): Promise<DeliveryAssignment | null> {
    const raw = await this.store.get(assignmentId);
    if (!raw) return null;

    const assignment = deliveryAssignmentSchema.parse(raw);
    if (assignment.assignmentId !== assignmentId) {
      throw new Error(`duo_face_delivery_assignments/${assignmentId} has a mismatched assignmentId field`);
    }
    return assignment;
  }

  /**
   * A malformed assignment among many is skipped and logged — one bad
   * document must not break a driver's whole list. Mirrors
   * MerchantOrderService.listOrders. Sorted newest-assigned-first in
   * application code (no orderBy/composite index assumed).
   */
  async listByDriverId(driverId: string): Promise<DeliveryAssignment[]> {
    const raw = await this.store.listByDriverId(driverId);
    return this.parseSkippingMalformed(raw, driverId, 'driverId');
  }

  /**
   * Same unlinked/broken-link boundary as
   * MerchantOrderService.requireLinkedCustomerAppShopId — kept as its own
   * copy rather than a shared refactor, to avoid touching that
   * already-shipped service for this phase. Public (not private) as of
   * Phase 13 so POST /merchant/deliveries can derive customerAppShopId
   * through this exact same check rather than a duplicated one.
   */
  requireLinkedCustomerAppShopId(shop: DuoFaceShop): string {
    if (!shop.customerAppShopId) {
      throw new AppError(409, 'Merchant shop is not linked to a Customer App shop.');
    }
    return shop.customerAppShopId;
  }

  /**
   * The assignment that currently represents an order (customer tracking):
   * the active one if any, otherwise the most recent. Only assignments whose
   * customerAppShopId equals the order's shop count — an assignment for a
   * different shop is never considered.
   */
  async getCurrentForOrder(orderId: string, customerAppShopId: string): Promise<DeliveryAssignment | null> {
    const raw = await this.store.listByOrderId(orderId);
    const candidates = raw
      .map((doc) => deliveryAssignmentSchema.safeParse(doc))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((a) => a.orderId === orderId && a.customerAppShopId === customerAppShopId);
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const aIso = toIsoString(a.assignedAt) ?? '';
      const bIso = toIsoString(b.assignedAt) ?? '';
      return aIso < bIso ? 1 : aIso > bIso ? -1 : 0;
    });
    return candidates.find((a) => ACTIVE_STATUSES.includes(a.status)) ?? candidates[0];
  }

  async listForMerchantShop(shop: DuoFaceShop): Promise<DeliveryAssignment[]> {
    const customerAppShopId = this.requireLinkedCustomerAppShopId(shop);
    const raw = await this.store.listByCustomerAppShopId(customerAppShopId);
    return this.parseSkippingMalformed(raw, customerAppShopId, 'customerAppShopId');
  }

  /**
   * Cross-shop access returns null (never leaks that another shop's
   * assignment exists) — the route converts null to 404.
   */
  async getForMerchantShop(shop: DuoFaceShop, assignmentId: string): Promise<DeliveryAssignment | null> {
    const customerAppShopId = this.requireLinkedCustomerAppShopId(shop);
    const assignment = await this.getById(assignmentId);
    if (!assignment || assignment.customerAppShopId !== customerAppShopId) {
      return null;
    }
    return assignment;
  }

  /**
   * Looks drivers up for DTO enrichment. A missing or malformed profile
   * yields null (the DTO shows driverName: null) rather than failing the
   * whole merchant view.
   */
  private async lookupDrivers(driverIds: string[]): Promise<Map<string, DuoFaceDriver | null>> {
    const drivers = new Map<string, DuoFaceDriver | null>();
    await Promise.all(
      [...new Set(driverIds)].map(async (driverId) => {
        try {
          drivers.set(driverId, await this.driverService.getById(driverId));
        } catch (err) {
          console.warn(
            `DeliveryAssignmentService: could not load driver ${driverId} -`,
            err instanceof Error ? err.message : 'unknown error'
          );
          drivers.set(driverId, null);
        }
      })
    );
    return drivers;
  }

  async listMerchantDeliveries(shop: DuoFaceShop): Promise<MerchantDeliveryAssignment[]> {
    await this.sweepExpiredOffers(shop);
    const assignments = await this.listForMerchantShop(shop);
    const drivers = await this.lookupDrivers(assignments.map((a) => a.driverId));
    return assignments.map((a) => toMerchantDto(a, drivers.get(a.driverId) ?? null));
  }

  async getMerchantDelivery(shop: DuoFaceShop, assignmentId: string): Promise<MerchantDeliveryAssignment | null> {
    const assignment = await this.getForMerchantShop(shop, assignmentId);
    if (!assignment) return null;
    const drivers = await this.lookupDrivers([assignment.driverId]);
    return toMerchantDto(assignment, drivers.get(assignment.driverId) ?? null);
  }

  /** Merchant-facing view of an assignment (driver name/phone joined from the Duo-Face profile). */
  async toMerchantDelivery(assignment: DeliveryAssignment): Promise<MerchantDeliveryAssignment> {
    const drivers = await this.lookupDrivers([assignment.driverId]);
    return toMerchantDto(assignment, drivers.get(assignment.driverId) ?? null);
  }

  /** An offer still waiting for an answer past OFFER_TTL_MS. */
  isStaleOffer(assignment: { status: string; assignedAt?: unknown }): boolean {
    const assignedAt = toIsoString(assignment.assignedAt);
    return assignment.status === 'assigned' && assignedAt !== null && this.now().getTime() - Date.parse(assignedAt) > OFFER_TTL_MS;
  }

  /**
   * Expires this shop's unanswered offers (assigned -> cancelled, atomically,
   * only if still assigned and still stale) and offers each order to the
   * next-nearest driver. Run lazily when the merchant views orders/deliveries,
   * so a restart can never leave an order waiting on an absent driver.
   */
  async sweepExpiredOffers(shop: DuoFaceShop): Promise<void> {
    const customerAppShopId = this.requireLinkedCustomerAppShopId(shop);
    const raw = await this.store.listByCustomerAppShopId(customerAppShopId);
    const stale = raw.flatMap((doc) => {
      const parsed = deliveryAssignmentSchema.safeParse(doc);
      return parsed.success && parsed.data.customerAppShopId === customerAppShopId && this.isStaleOffer(parsed.data) ? [parsed.data] : [];
    });
    await Promise.all(stale.map((assignment) => this.expireOffer(assignment.assignmentId)));
  }

  /**
   * A driver's unanswered offers past the TTL are expired (and re-offered to
   * the next driver). Run before listing a driver's assignments / changing
   * duty, so a dead offer can never keep them "busy".
   */
  async expireStaleOffersForDriver(driverId: string): Promise<void> {
    const raw = await this.store.listByDriverId(driverId);
    const stale = raw.flatMap((doc) => {
      const parsed = deliveryAssignmentSchema.safeParse(doc);
      return parsed.success && parsed.data.driverId === driverId && this.isStaleOffer(parsed.data) ? [parsed.data] : [];
    });
    await Promise.all(stale.map((assignment) => this.expireOffer(assignment.assignmentId)));
  }

  /** In-progress deliveries and still-live offers (an expired offer is not "active"). */
  async listActiveForDriver(driverId: string): Promise<DeliveryAssignment[]> {
    const all = await this.listByDriverId(driverId);
    return all.filter((a) => ACTIVE_ASSIGNMENT_STATUSES.includes(a.status) && !this.isStaleOffer(a));
  }

  /** Atomic; a no-op if the driver answered in the meantime. Triggers re-dispatch only when it really expired. */
  async expireOffer(assignmentId: string): Promise<DeliveryAssignment | null> {
    let expired = false;
    const updated = await this.store.runTransaction(assignmentId, (raw) => {
      if (!raw) throw new AppError(404, 'Assignment not found.');
      const current = deliveryAssignmentSchema.parse(raw);
      if (!this.isStaleOffer(current) || !isValidTransition(current.status, 'cancelled')) return raw;
      expired = true;
      const at = this.now();
      return { ...current, status: 'cancelled', cancelledAt: at, updatedAt: at };
    });
    if (!expired) return null;
    const result = deliveryAssignmentSchema.parse(updated);
    this.runEffect(() => this.dispatch.redispatch(result.orderId, result.customerAppShopId));
    return result;
  }

  /**
   * The current assignment per order for this shop, so the orders view
   * never has to infer assignment state itself: an active assignment wins;
   * otherwise the most recent (terminal) one is reported. Relies on
   * listForMerchantShop's newest-first ordering.
   */
  async latestAssignmentsByOrder(shop: DuoFaceShop): Promise<Map<string, MerchantOrderDeliveryAssignment>> {
    await this.sweepExpiredOffers(shop);
    const assignments = await this.listForMerchantShop(shop);
    const latest = new Map<string, DeliveryAssignment>();
    for (const assignment of assignments) {
      const existing = latest.get(assignment.orderId);
      if (!existing || (!ACTIVE_STATUSES.includes(existing.status) && ACTIVE_STATUSES.includes(assignment.status))) {
        latest.set(assignment.orderId, assignment);
      }
    }
    return new Map(
      [...latest.entries()].map(([orderId, a]) => [orderId, { assignmentId: a.assignmentId, status: a.status }])
    );
  }

  /**
   * Every transition goes through store.runTransaction: read current
   * state, verify driver ownership, verify the transition is allowed via
   * isValidTransition, then write — all inside one atomic callback (same
   * shape as InventoryService.setQuantity/adjustQuantity). Two concurrent
   * calls on the same assignment can never both succeed: the second one
   * re-reads the already-updated status and fails isValidTransition.
   */
  private async transitionAssignment(
    assignmentId: string,
    driverId: string,
    to: DeliveryAssignmentStatus
  ): Promise<DeliveryAssignment> {
    // Plaintext delivery code: lives only in this closure until it is sent after commit.
    let issuedCode: string | null = null;
    const updated = await this.store.runTransaction(assignmentId, (raw) => {
      issuedCode = null; // the updater may re-run on contention; only the committed run counts
      if (!raw) {
        throw new AppError(404, 'Assignment not found.');
      }
      const current = deliveryAssignmentSchema.parse(raw);
      // Don't leak that another driver's assignment exists — same 404 as a
      // missing one.
      if (current.driverId !== driverId) {
        throw new AppError(404, 'Assignment not found.');
      }
      if (!isValidTransition(current.status, to)) {
        throw new AppError(409, `Cannot transition assignment from ${current.status} to ${to}.`);
      }
      // A late answer to an offer that already timed out must not win the order.
      if ((to === 'accepted' || to === 'rejected') && this.isStaleOffer(current)) {
        throw new AppError(409, 'This offer expired.');
      }

      const timestampField = TIMESTAMP_FIELD_BY_STATUS[to];
      let otpFields: Record<string, unknown> = {};
      if (to === 'picked_up' && this.otp) {
        issuedCode = this.otp.generate();
        otpFields = { deliveryOtpHash: this.otp.hash(current.assignmentId, issuedCode), deliveryOtpAttempts: 0 };
      }
      return {
        ...current,
        ...otpFields,
        status: to,
        ...(timestampField ? { [timestampField]: this.now() } : {}),
        updatedAt: this.now(),
      };
    }, to === 'delivered' ? (next) => [{ collection: ORDER_SYNC_COLLECTION, id: String(next.orderId), data: buildPendingOrderSyncRecord(String(next.orderId), new Date()) }] : undefined);

    const result = deliveryAssignmentSchema.parse(updated);
    // Announce the committed transition to any customer watching this order.
    // Fire-and-forget: a realtime problem must not fail the driver's action.
    // This only READS assignment state; it changes nothing in the Customer App.
    this.events.publish(result.orderId, { type: 'delivery_status', status: toCustomerStatus(result.status) });

    // Then (in the background, after the Duo-Face transaction has committed):
    // Customer App sync + customer notifications. Their outcome can never
    // change the assignment state committed above.
    // A rejected offer goes to the next-nearest driver (never fails the driver's action).
    if (result.status === 'rejected') this.runEffect(() => this.dispatch.redispatch(result.orderId, result.customerAppShopId));
    if (result.status === 'accepted') this.runEffect(() => this.effects.onAccepted(result));
    if (result.status === 'picked_up') this.runEffect(() => this.effects.onPickedUp(result));
    if (result.status === 'picked_up' && issuedCode) {
      const code: string = issuedCode;
      this.runEffect(() => this.codes.issue(result.orderId, result.customerAppShopId, code));
    }
    if (result.status === 'delivered') this.runEffect(() => this.effects.onDelivered(result));
    return result;
  }

  async acceptAssignment(assignmentId: string, driverId: string): Promise<DeliveryAssignment> {
    return this.transitionAssignment(assignmentId, driverId, 'accepted');
  }

  async rejectAssignment(assignmentId: string, driverId: string): Promise<DeliveryAssignment> {
    return this.transitionAssignment(assignmentId, driverId, 'rejected');
  }

  async markPickedUp(assignmentId: string, driverId: string): Promise<DeliveryAssignment> {
    return this.transitionAssignment(assignmentId, driverId, 'picked_up');
  }

  /**
   * Checks the customer's delivery code for this driver's picked-up
   * assignment. Attempts are counted atomically in the same transaction as the
   * check, and a wrong guess is persisted (so it cannot be retried for free)
   * before the error is raised. After MAX_OTP_ATTEMPTS wrong guesses the code
   * is locked, and a locked code rejects even the correct digits.
   */
  async verifyDeliveryOtp(assignmentId: string, driverId: string, code: string): Promise<void> {
    if (!this.otp) throw new AppError(409, 'The customer code is not available for this delivery.');
    const otp = this.otp;
    const state: { outcome: 'ok' | 'wrong' | 'locked' | 'unavailable'; attemptsLeft: number } = { outcome: 'unavailable', attemptsLeft: 0 };

    await this.store.runTransaction(assignmentId, (raw) => {
      state.outcome = 'unavailable';
      if (!raw) throw new AppError(404, 'Assignment not found.');
      const current = deliveryAssignmentSchema.parse(raw);
      if (current.driverId !== driverId) throw new AppError(404, 'Assignment not found.');
      if (current.status !== 'picked_up') throw new AppError(409, `Cannot deliver an assignment that is ${current.status}.`);
      const attempts = current.deliveryOtpAttempts ?? 0;
      if (!current.deliveryOtpHash) return raw; // no code was issued for this delivery
      if (current.deliveryOtpLockedAt || attempts >= MAX_OTP_ATTEMPTS) {
        state.outcome = 'locked';
        return raw;
      }
      if (otp.verify(current.assignmentId, code, current.deliveryOtpHash)) {
        state.outcome = 'ok';
        return raw;
      }
      const next = attempts + 1;
      state.attemptsLeft = MAX_OTP_ATTEMPTS - next;
      state.outcome = 'wrong';
      return { ...current, deliveryOtpAttempts: next, ...(next >= MAX_OTP_ATTEMPTS ? { deliveryOtpLockedAt: this.now() } : {}), updatedAt: this.now() };
    });

    if (state.outcome === 'ok') return;
    if (state.outcome === 'locked') throw new AppError(423, 'Too many wrong codes. Get within the delivery radius to finish this delivery.');
    if (state.outcome === 'wrong') {
      throw new AppError(409, state.attemptsLeft > 0 ? `Incorrect code. ${state.attemptsLeft} attempt${state.attemptsLeft === 1 ? '' : 's'} left.` : 'Too many wrong codes. Get within the delivery radius to finish this delivery.');
    }
    throw new AppError(409, 'The customer code is not available for this delivery.');
  }

  async markDelivered(assignmentId: string, driverId: string): Promise<DeliveryAssignment> {
    return this.transitionAssignment(assignmentId, driverId, 'delivered');
  }

  private parseSkippingMalformed(
    raw: Record<string, unknown>[],
    expectedValue: string,
    field: 'driverId' | 'customerAppShopId'
  ): DeliveryAssignment[] {
    const assignments: DeliveryAssignment[] = [];
    for (const doc of raw) {
      const parsed = deliveryAssignmentSchema.safeParse(doc);
      if (!parsed.success) {
        console.warn('DeliveryAssignmentService: skipping malformed delivery assignment', parsed.error.issues);
        continue;
      }
      if (parsed.data[field] !== expectedValue) {
        console.warn(`DeliveryAssignmentService: skipping assignment ${parsed.data.assignmentId} with mismatched ${field}`);
        continue;
      }
      assignments.push(parsed.data);
    }

    assignments.sort((a, b) => {
      const aIso = toIsoString(a.assignedAt) ?? '';
      const bIso = toIsoString(b.assignedAt) ?? '';
      return aIso < bIso ? 1 : aIso > bIso ? -1 : 0;
    });
    return assignments;
  }
}
