import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreCustomerAppShopProvider } from '../integrations/customerApp/FirestoreCustomerAppShopProvider';
import type { CustomerAppShopProvider } from '../integrations/customerApp/CustomerAppShopProvider';
import { createDeliveryGeocoder } from '../integrations/geocoding/createDeliveryGeocoder';
import type { DeliveryGeocoder } from '../integrations/geocoding/DeliveryGeocoder';
import { AppError } from '../middleware/errorHandler';
import { customerAppOrderSnapshotSchema } from '../types/customerAppOrder';
import type { DeliveryAssignment } from '../types/deliveryAssignment';
import type { DeliveryOrder } from '../types/deliveryOrder';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import type { DuoFaceShop } from '../types/duoFaceShop';
import { DeliveryAssignmentService } from './deliveryAssignmentService';

/**
 * The driver NEVER receives the customer's phone number (docs/decisions/028,
 * superseding 018/019): they only learn whether they may place a masked call,
 * which is allowed while the delivery is in progress.
 */
const DRIVER_CALLABLE_STATUSES = ['accepted', 'picked_up'];

/**
 * The single read boundary from a Duo-Face delivery assignment to its
 * Customer App order (docs/decisions/018). Access is always resolved
 * through the assignment first — there is deliberately no lookup by
 * orderId. Read-only: only CustomerAppOrderProvider.getOrderById and
 * CustomerAppShopProvider.getShop are ever called.
 */
export class DeliveryOrderService {
  constructor(
    private readonly assignmentService: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly orderProvider: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly shopProvider: CustomerAppShopProvider = new FirestoreCustomerAppShopProvider(),
    private readonly geocoder: DeliveryGeocoder = createDeliveryGeocoder()
  ) {}

  /**
   * Driver ownership: assignment.driverId must equal the authenticated
   * driver's id; otherwise 404. A driver who rejected the assignment loses
   * access (404); the phone number is withheld until acceptance.
   */
  async getForDriver(driver: DuoFaceDriver, assignmentId: string): Promise<DeliveryOrder> {
    const assignment = await this.assignmentService.getById(assignmentId);
    if (!assignment || assignment.driverId !== driver.driverId || assignment.status === 'rejected') {
      throw new AppError(404, 'Assignment not found.');
    }
    return this.loadOrder(assignment, false, true, DRIVER_CALLABLE_STATUSES.includes(assignment.status));
  }

  /** Merchant ownership: assignment.customerAppShopId must equal the merchant's linked shop; otherwise 404. */
  async getForMerchantShop(shop: DuoFaceShop, assignmentId: string): Promise<DeliveryOrder> {
    const assignment = await this.assignmentService.getForMerchantShop(shop, assignmentId);
    if (!assignment) {
      throw new AppError(404, 'Assignment not found.');
    }
    return this.loadOrder(assignment, true, false);
  }

  private async loadOrder(
    assignment: DeliveryAssignment,
    includePhoneNumber: boolean,
    includeDestination: boolean,
    driverMayCall = false
  ): Promise<DeliveryOrder> {
    const raw = await this.orderProvider.getOrderById(assignment.orderId);
    if (!raw) {
      throw new AppError(404, 'The order for this assignment could not be found.');
    }

    const order = customerAppOrderSnapshotSchema.parse(raw);

    // Integration inconsistency, not a client error: never expose the order,
    // never repair anything, log ids only.
    if (order.orderId !== assignment.orderId || order.shopId !== assignment.customerAppShopId) {
      console.error(
        `DeliveryOrderService: assignment ${assignment.assignmentId} is inconsistent with its Customer App order (orderId or shopId mismatch)`
      );
      throw new AppError(500, 'Delivery order data is inconsistent.');
    }

    const shopName = await this.readShopName(assignment.customerAppShopId);
    const destination = includeDestination ? await this.resolveDestination(order.delivery.fullAddress) : null;
    return {
      assignmentId: assignment.assignmentId,
      orderId: order.orderId,
      ...(shopName ? { shopName } : {}),
      delivery: {
        label: order.delivery.label,
        fullAddress: order.delivery.fullAddress,
        ...(includePhoneNumber && order.delivery.phoneNumber ? { phoneNumber: order.delivery.phoneNumber } : {}),
      },
      ...(destination ? { destination } : {}),
      ...(includeDestination ? { canCallCustomer: driverMayCall && Boolean(order.delivery.phoneNumber) } : {}),
      items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
      itemCount: order.items.length,
      total: order.pricing.total,
    };
  }

  /** Geocoding failure is non-fatal: no destination just means no map location. */
  private async resolveDestination(fullAddress: string) {
    try {
      const result = await this.geocoder.geocode(fullAddress);
      const valid =
        result &&
        Number.isFinite(result.latitude) &&
        Number.isFinite(result.longitude) &&
        Math.abs(result.latitude) <= 90 &&
        Math.abs(result.longitude) <= 180;
      return valid ? { latitude: result.latitude, longitude: result.longitude } : null;
    } catch {
      return null; // never log the address
    }
  }

  private async readShopName(customerAppShopId: string): Promise<string | undefined> {
    try {
      const shop = (await this.shopProvider.getShop(customerAppShopId)) as { name?: unknown } | null;
      return typeof shop?.name === 'string' && shop.name.length > 0 ? shop.name : undefined;
    } catch {
      return undefined;
    }
  }
}
