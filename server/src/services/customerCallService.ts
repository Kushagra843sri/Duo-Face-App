import { randomUUID } from 'crypto';

import { loadExotelCallConfig } from '../config/telephony';
import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreCallLogStore } from '../integrations/firebase/FirestoreCallLogStore';
import type { CallLogStore } from '../integrations/firebase/FirestoreCallLogStore';
import { createCallProvider, verifyCallToken } from '../integrations/telephony/CallProvider';
import type { CallProvider } from '../integrations/telephony/CallProvider';
import { AppError } from '../middleware/errorHandler';
import { callLogSchema, callStatusSchema } from '../types/callLog';
import type { CallStatus } from '../types/callLog';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import { DeliveryAssignmentService } from './deliveryAssignmentService';

/** At most this many masked calls per assignment within the window (cost + harassment guard). */
export const MAX_CALLS_PER_WINDOW = 5;
export const CALL_WINDOW_MS = 30 * 60 * 1000;

const CALLABLE_STATUSES = ['accepted', 'picked_up'];

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return 0;
}

/**
 * Masked driver -> customer calls (docs/decisions/028). The driver never
 * receives the customer's number: the server reads it from the Customer App
 * order, hands it to the telephony provider, and the provider rings the
 * driver first, then the customer. Neither number is stored in our log or
 * returned to any client.
 */
export class CustomerCallService {
  constructor(
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly logs: CallLogStore = new FirestoreCallLogStore(),
    private readonly provider: CallProvider = createCallProvider(),
    private readonly webhookSecret: string | null = loadExotelCallConfig()?.webhookSecret ?? null,
    private readonly now: () => Date = () => new Date()
  ) {}

  async callCustomer(driver: DuoFaceDriver, assignmentId: string): Promise<{ callId: string; status: 'connecting' }> {
    const assignment = await this.assignments.getById(assignmentId);
    if (!assignment || assignment.driverId !== driver.driverId) {
      throw new AppError(404, 'Assignment not found.');
    }
    if (!CALLABLE_STATUSES.includes(assignment.status)) {
      throw new AppError(409, 'You can call the customer while the delivery is in progress.');
    }
    if (!driver.phoneNumber) {
      throw new AppError(409, 'Add your phone number to your profile to place calls.');
    }
    if (!this.provider.enabled) {
      throw new AppError(503, 'Calling is not available right now.');
    }

    const nowMs = this.now().getTime();
    const recent = (await this.logs.listByAssignmentId(assignmentId)).filter((doc) => nowMs - toMillis(doc.createdAt) < CALL_WINDOW_MS);
    if (recent.length >= MAX_CALLS_PER_WINDOW) {
      throw new AppError(429, 'Call limit reached for this delivery. Please try again later.');
    }

    const raw = (await this.orders.getOrderById(assignment.orderId)) as
      | { orderId?: unknown; shopId?: unknown; delivery?: { phoneNumber?: unknown } }
      | null;
    if (!raw || raw.orderId !== assignment.orderId || raw.shopId !== assignment.customerAppShopId) {
      throw new AppError(404, 'Assignment not found.');
    }
    const customerPhone = raw.delivery?.phoneNumber;
    if (typeof customerPhone !== 'string' || customerPhone.length === 0) {
      throw new AppError(409, 'No customer number is available for this order.');
    }

    const callId = randomUUID();
    const at = this.now();
    // Written before dialing so the status callback can always find it, and so a crash still counts toward the limit.
    await this.logs.set(callId, {
      callId,
      assignmentId,
      orderId: assignment.orderId,
      driverId: driver.driverId,
      status: 'initiated',
      createdAt: at,
      updatedAt: at,
    });

    try {
      const { providerCallSid } = await this.provider.connectCall({ driverPhone: driver.phoneNumber, customerPhone, callId });
      await this.logs.set(callId, { ...callLogSchema.parse(await this.logs.get(callId)), providerCallSid, updatedAt: this.now() });
    } catch {
      await this.logs.set(callId, { ...callLogSchema.parse(await this.logs.get(callId)), status: 'failed', updatedAt: this.now() });
      // One generic message: the provider error (which could echo a number) never reaches the driver.
      throw new AppError(503, 'Could not place the call. Please try again.');
    }
    return { callId, status: 'connecting' };
  }

  /**
   * Exotel's terminal status callback. Authenticated by the HMAC token in the
   * URL we gave it; anything unverifiable or unknown is ignored (the route
   * answers 200 regardless so a prober learns nothing).
   */
  async recordStatus(callId: unknown, token: unknown, payload: { status?: unknown; durationSeconds?: unknown }): Promise<boolean> {
    if (typeof callId !== 'string' || !this.webhookSecret || !verifyCallToken(this.webhookSecret, callId, token)) return false;
    const raw = await this.logs.get(callId);
    if (!raw) return false;
    const log = callLogSchema.parse(raw);

    const parsedStatus = callStatusSchema.safeParse(typeof payload.status === 'string' ? payload.status.toLowerCase() : undefined);
    const status: CallStatus = parsedStatus.success ? parsedStatus.data : log.status;
    const seconds = Number(payload.durationSeconds);
    await this.logs.set(callId, {
      ...log,
      status,
      ...(Number.isFinite(seconds) && seconds >= 0 ? { durationSeconds: Math.floor(seconds) } : {}),
      updatedAt: this.now(),
    });
    return true;
  }
}
