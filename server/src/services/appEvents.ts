import { loadAdminUids } from '../config/admin';
import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { DeliveryAssignment } from '../types/deliveryAssignment';
import { DriverService } from './driverService';
import { DuoFaceShopService } from './duoFaceShopService';
import { Notifier } from './notifier';
import type { NotifyInput } from './notifier';

export type KycSubject = { kind: 'driver'; driverId: string } | { kind: 'merchant'; shopId: string };

/**
 * Things that happen in the business that somebody should hear about. The
 * services call these AFTER their own change is saved; none of them may throw
 * or wait on the caller. Which person gets which message is decided here, not
 * in the services.
 */
export interface AppEvents {
  /** A cash-on-delivery order was placed. (Online orders announce themselves when paid.) */
  orderPlaced(orderId: string): Promise<void>;
  paymentConfirmed(orderId: string): Promise<void>;
  /** Unpaid online order timed out and was cancelled. */
  paymentExpired(orderId: string): Promise<void>;
  orderConfirmed(orderId: string): Promise<void>;
  orderRejected(orderId: string): Promise<void>;
  /** The customer cancelled an order the shop could already see. */
  customerCancelled(orderId: string): Promise<void>;
  /** Money is owed back and an admin must act. */
  refundDue(orderId: string): Promise<void>;
  refundStarted(orderId: string): Promise<void>;
  refundCompleted(orderId: string): Promise<void>;
  driverOffered(assignment: DeliveryAssignment): Promise<void>;
  driverAccepted(assignment: DeliveryAssignment): Promise<void>;
  driverPickedUp(assignment: DeliveryAssignment): Promise<void>;
  driverNearby(orderId: string): Promise<void>;
  kycSubmitted(subject: KycSubject, version: string): Promise<void>;
  kycDecided(subject: KycSubject, approved: boolean, version: string): Promise<void>;
}

export class NoopAppEvents implements AppEvents {
  async orderPlaced() {}
  async paymentConfirmed() {}
  async paymentExpired() {}
  async orderConfirmed() {}
  async orderRejected() {}
  async customerCancelled() {}
  async refundDue() {}
  async refundStarted() {}
  async refundCompleted() {}
  async driverOffered() {}
  async driverAccepted() {}
  async driverPickedUp() {}
  async driverNearby() {}
  async kycSubmitted() {}
  async kycDecided() {}
}

/**
 * Delegating holder, no-op until server.ts installs the real implementation,
 * so unit tests and the bare `app` never send anything. Every call is
 * fire-and-forget and swallows errors.
 */
export class AppEventsHub implements AppEvents {
  private delegate: AppEvents = new NoopAppEvents();

  install(delegate: AppEvents): void {
    this.delegate = delegate;
  }

  private run(fn: (d: AppEvents) => Promise<void>): Promise<void> {
    try {
      return fn(this.delegate).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  orderPlaced = (id: string) => this.run((d) => d.orderPlaced(id));
  paymentConfirmed = (id: string) => this.run((d) => d.paymentConfirmed(id));
  paymentExpired = (id: string) => this.run((d) => d.paymentExpired(id));
  orderConfirmed = (id: string) => this.run((d) => d.orderConfirmed(id));
  orderRejected = (id: string) => this.run((d) => d.orderRejected(id));
  customerCancelled = (id: string) => this.run((d) => d.customerCancelled(id));
  refundDue = (id: string) => this.run((d) => d.refundDue(id));
  refundStarted = (id: string) => this.run((d) => d.refundStarted(id));
  refundCompleted = (id: string) => this.run((d) => d.refundCompleted(id));
  driverOffered = (a: DeliveryAssignment) => this.run((d) => d.driverOffered(a));
  driverAccepted = (a: DeliveryAssignment) => this.run((d) => d.driverAccepted(a));
  driverPickedUp = (a: DeliveryAssignment) => this.run((d) => d.driverPickedUp(a));
  driverNearby = (id: string) => this.run((d) => d.driverNearby(id));
  kycSubmitted = (s: KycSubject, v: string) => this.run((d) => d.kycSubmitted(s, v));
  kycDecided = (s: KycSubject, ok: boolean, v: string) => this.run((d) => d.kycDecided(s, ok, v));
}

export const appEvents = new AppEventsHub();

type Doc = Record<string, unknown>;

/** The real thing: resolves recipients and hands each message to the Notifier. */
export class AppEventService implements AppEvents {
  constructor(
    private readonly notifier: Notifier = new Notifier(),
    private readonly orders: CustomerStore = new FirestoreCustomerStore(),
    private readonly shops: Pick<DuoFaceShopService, 'getByCustomerAppShopId' | 'getById'> = new DuoFaceShopService(),
    private readonly drivers: Pick<DriverService, 'getById'> = new DriverService(),
    private readonly adminUids: ReadonlySet<string> = loadAdminUids()
  ) {}

  // ---- recipient lookups: each returns null when the person cannot be found (then nothing is sent) ----

  private async order(orderId: string): Promise<Doc | null> {
    return this.orders.getOrder(orderId);
  }

  private async merchantUidForShop(customerAppShopId: string): Promise<string | null> {
    const shop = await this.shops.getByCustomerAppShopId(customerAppShopId);
    return shop && shop.status === 'active' ? shop.merchantFirebaseUid : null;
  }

  private async send(input: Omit<NotifyInput, 'recipientUid'> & { recipientUid: string | null }): Promise<void> {
    if (!input.recipientUid) return;
    await this.notifier.notify({ ...input, recipientUid: input.recipientUid });
  }

  private async toCustomer(orderId: string, type: NotifyInput['type'], refId = orderId): Promise<void> {
    const order = await this.order(orderId);
    await this.send({ recipientUid: typeof order?.customerId === 'string' ? order.customerId : null, type, refId, orderId });
  }

  private async toShopOf(orderId: string, type: NotifyInput['type'], refId = orderId): Promise<void> {
    const order = await this.order(orderId);
    if (typeof order?.shopId !== 'string') return;
    await this.send({ recipientUid: await this.merchantUidForShop(order.shopId), type, refId, orderId });
  }

  private async toAdmins(type: NotifyInput['type'], refId: string, orderId?: string): Promise<void> {
    await Promise.all([...this.adminUids].map((uid) => this.send({ recipientUid: uid, type, refId, ...(orderId ? { orderId } : {}) })));
  }

  // ---- events ----

  orderPlaced = (orderId: string) => this.toShopOf(orderId, 'new_order');

  async paymentConfirmed(orderId: string): Promise<void> {
    // Online orders reach the shop only now, when they are paid.
    await Promise.all([this.toCustomer(orderId, 'payment_confirmed'), this.toShopOf(orderId, 'new_order')]);
  }

  paymentExpired = (orderId: string) => this.toCustomer(orderId, 'order_cancelled_unpaid');
  orderConfirmed = (orderId: string) => this.toCustomer(orderId, 'order_confirmed');
  orderRejected = (orderId: string) => this.toCustomer(orderId, 'order_rejected');
  customerCancelled = (orderId: string) => this.toShopOf(orderId, 'order_cancelled_by_customer');
  refundDue = (orderId: string) => this.toAdmins('admin_refund_due', orderId, orderId);
  refundStarted = (orderId: string) => this.toCustomer(orderId, 'refund_started');
  refundCompleted = (orderId: string) => this.toCustomer(orderId, 'refund_completed');
  driverNearby = (orderId: string) => this.toCustomer(orderId, 'driver_nearby');

  async driverOffered(a: DeliveryAssignment): Promise<void> {
    const driver = await this.drivers.getById(a.driverId);
    // refId is the assignment, so a re-offer to the next driver is a new notification.
    await this.send({ recipientUid: driver && driver.status === 'active' ? driver.firebaseUid : null, type: 'new_delivery_offer', refId: a.assignmentId, orderId: a.orderId });
  }

  async driverAccepted(a: DeliveryAssignment): Promise<void> {
    await this.send({ recipientUid: await this.merchantUidForShop(a.customerAppShopId), type: 'shop_driver_accepted', refId: a.assignmentId, orderId: a.orderId });
  }

  async driverPickedUp(a: DeliveryAssignment): Promise<void> {
    await this.send({ recipientUid: await this.merchantUidForShop(a.customerAppShopId), type: 'shop_driver_picked_up', refId: a.assignmentId, orderId: a.orderId });
  }

  async kycSubmitted(subject: KycSubject, version: string): Promise<void> {
    const key = subject.kind === 'driver' ? subject.driverId : subject.shopId;
    await this.toAdmins('admin_kyc_submitted', `${subject.kind}:${key}:${version}`);
  }

  async kycDecided(subject: KycSubject, approved: boolean, version: string): Promise<void> {
    const type = approved ? 'kyc_approved' : 'kyc_rejected';
    if (subject.kind === 'driver') {
      const driver = await this.drivers.getById(subject.driverId);
      await this.send({ recipientUid: driver?.firebaseUid ?? null, type, refId: `driver:${subject.driverId}:${version}` });
      return;
    }
    const shop = await this.shops.getById(subject.shopId);
    await this.send({ recipientUid: shop?.merchantFirebaseUid ?? null, type, refId: `merchant:${subject.shopId}:${version}` });
  }
}
