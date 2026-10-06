import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreCustomerAppShopProvider } from '../integrations/customerApp/FirestoreCustomerAppShopProvider';
import type { CustomerAppShopProvider } from '../integrations/customerApp/CustomerAppShopProvider';
import { AppError } from '../middleware/errorHandler';
import { customerAppOrderSnapshotSchema } from '../types/customerAppOrder';
import type { CustomerAppOrderSnapshot } from '../types/customerAppOrder';
import type { DuoFaceShop } from '../types/duoFaceShop';
import type { MerchantOrderDetail, MerchantOrderSummary } from '../types/merchantOrder';
import { OrderStatusService } from './orderStatusService';
import type { MerchantStatusTarget } from '../types/merchantOrder';

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

function toSummary(order: CustomerAppOrderSnapshot, createdAt: string): MerchantOrderSummary {
  return {
    orderId: order.orderId,
    status: order.status,
    itemCount: order.items.length,
    total: order.pricing.total,
    createdAt,
  };
}

export class MerchantOrderService {
  constructor(
    private readonly orderProvider: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly shopProvider: CustomerAppShopProvider = new FirestoreCustomerAppShopProvider(),
    private readonly statusService: OrderStatusService = new OrderStatusService()
  ) {}

  /** Merchant moves its own shop's order forward (or rejects it). Allowed moves are decided by orderState. */
  async updateStatus(shop: DuoFaceShop, orderId: string, to: MerchantStatusTarget): Promise<{ orderId: string; status: string }> {
    const customerAppShopId = await this.requireLinkedCustomerAppShopId(shop);
    const status = await this.statusService.transition(orderId, customerAppShopId, to, { type: 'merchant', id: shop.shopId });
    return { orderId, status };
  }

  /**
   * Same unlinked/broken-link boundary as
   * MerchantProductCatalogService.listCatalog — kept as its own copy
   * rather than a shared refactor, to avoid touching that already-shipped
   * service for this phase.
   */
  private async requireLinkedCustomerAppShopId(shop: DuoFaceShop): Promise<string> {
    if (!shop.customerAppShopId) {
      throw new AppError(409, 'Merchant shop is not linked to a Customer App shop.');
    }
    const linkedShop = await this.shopProvider.getShop(shop.customerAppShopId);
    if (!linkedShop) {
      throw new AppError(
        409,
        `The Customer App shop ${shop.customerAppShopId} linked to this merchant shop no longer exists.`
      );
    }
    return shop.customerAppShopId;
  }

  /**
   * A malformed order among many is skipped and logged — one bad document
   * must not break a merchant's whole order list (same policy as
   * MerchantProductCatalogService for products). Sorted newest-first in
   * application code, not via a Firestore `orderBy` (no confirmed
   * shopId+createdAt composite index — see
   * docs/decisions/011-merchant-order-boundary.md).
   */
  async listOrders(shop: DuoFaceShop): Promise<MerchantOrderSummary[]> {
    const customerAppShopId = await this.requireLinkedCustomerAppShopId(shop);
    const rawOrders = await this.orderProvider.listOrdersByShopId(customerAppShopId);

    const summaries: MerchantOrderSummary[] = [];
    for (const raw of rawOrders) {
      const parsed = customerAppOrderSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('MerchantOrderService: skipping malformed Customer App order', parsed.error.issues);
        continue;
      }
      if (parsed.data.shopId !== customerAppShopId) {
        console.warn(`MerchantOrderService: skipping order ${parsed.data.orderId} with mismatched shopId`);
        continue;
      }
      // An online order the customer has not paid for yet is not the shop's order.
      if (parsed.data.paymentStatus === 'awaiting_payment') continue;
      const createdAt = toIsoString(parsed.data.createdAt);
      if (!createdAt) {
        console.warn(`MerchantOrderService: skipping order ${parsed.data.orderId} with unparseable createdAt`);
        continue;
      }
      summaries.push(toSummary(parsed.data, createdAt));
    }

    summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return summaries;
  }

  /**
   * Unlike listOrders, a malformed document here is a hard failure (thrown,
   * not skipped) — this is a specific single order being requested, so
   * silently treating it as "not found" would be misleading.
   */
  async getOrder(shop: DuoFaceShop, orderId: string): Promise<MerchantOrderDetail | null> {
    const customerAppShopId = await this.requireLinkedCustomerAppShopId(shop);

    const raw = await this.orderProvider.getOrderById(orderId);
    if (!raw) return null;

    const order = customerAppOrderSnapshotSchema.parse(raw);

    // Cross-shop isolation: never reveal another shop's order, even to a
    // merchant who already knows/guesses a valid orderId.
    if (order.shopId !== customerAppShopId || order.paymentStatus === 'awaiting_payment') {
      return null;
    }

    const createdAt = toIsoString(order.createdAt);
    if (!createdAt) {
      throw new Error(`Order ${orderId} has an unparseable createdAt`);
    }

    return {
      ...toSummary(order, createdAt),
      items: order.items,
      delivery: order.delivery,
      paymentStatus: order.paymentStatus,
    };
  }
}
