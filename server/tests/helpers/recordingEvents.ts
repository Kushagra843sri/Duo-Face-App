import type { AppEvents, KycSubject } from '../../src/services/appEvents';
import type { DeliveryAssignment } from '../../src/types/deliveryAssignment';

/** Records which business events fired, so hook points can be asserted without any notification machinery. */
export class RecordingEvents implements AppEvents {
  calls: string[] = [];

  private rec(name: string, id: string) {
    this.calls.push(`${name}:${id}`);
    return Promise.resolve();
  }

  orderPlaced = (id: string) => this.rec('orderPlaced', id);
  paymentConfirmed = (id: string) => this.rec('paymentConfirmed', id);
  paymentExpired = (id: string) => this.rec('paymentExpired', id);
  orderConfirmed = (id: string) => this.rec('orderConfirmed', id);
  orderRejected = (id: string) => this.rec('orderRejected', id);
  customerCancelled = (id: string) => this.rec('customerCancelled', id);
  refundDue = (id: string) => this.rec('refundDue', id);
  refundStarted = (id: string) => this.rec('refundStarted', id);
  refundCompleted = (id: string) => this.rec('refundCompleted', id);
  driverOffered = (a: DeliveryAssignment) => this.rec('driverOffered', a.assignmentId);
  driverAccepted = (a: DeliveryAssignment) => this.rec('driverAccepted', a.assignmentId);
  driverPickedUp = (a: DeliveryAssignment) => this.rec('driverPickedUp', a.assignmentId);
  driverNearby = (id: string) => this.rec('driverNearby', id);
  kycSubmitted = (s: KycSubject, v: string) => this.rec('kycSubmitted', `${s.kind}:${'driverId' in s ? s.driverId : s.shopId}:${v}`);
  kycDecided = (s: KycSubject, ok: boolean, v: string) =>
    this.rec(ok ? 'kycApproved' : 'kycRejected', `${s.kind}:${'driverId' in s ? s.driverId : s.shopId}:${v}`);
}
