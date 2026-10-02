import { MerchantOrderService } from '../../src/services/merchantOrderService';
import { AppError } from '../../src/middleware/errorHandler';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import type { DuoFaceShop } from '../../src/types/duoFaceShop';

const now = new Date();

function buildShop(overrides: Partial<DuoFaceShop> = {}): DuoFaceShop {
  return {
    shopId: 'duo-face-shop-1',
    name: 'Test Shop',
    status: 'active',
    merchantFirebaseUid: 'uid-1',
    customerAppShopId: 'shop-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const foundShopProvider: CustomerAppShopProvider = {
  getShop: async (id) => (id === 'shop-1' ? { id: 'shop-1', name: 'Sharma Kirana' } : null),
};

function fakeOrderProvider(orders: unknown[], byId: Record<string, unknown> = {}): CustomerAppOrderProvider {
  return {
    listOrdersByShopId: async () => orders,
    getOrderById: async (orderId) => byId[orderId] ?? null,
    markOrderDelivered: async () => {
      throw new Error('not used');
    },
  };
}

function baseOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderId: 'order-1',
    shopId: 'shop-1',
    status: 'pending',
    paymentStatus: 'paid',
    items: [{ productId: 'product-1', name: 'Amul Milk', price: 28, quantity: 2, subtotal: 56 }],
    delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    pricing: { total: 71 },
    createdAt: now,
    ...overrides,
  };
}

describe('MerchantOrderService.listOrders', () => {
  it('returns order summaries for the linked shop, newest first', async () => {
    const older = baseOrder({ orderId: 'order-old', createdAt: new Date(now.getTime() - 60_000) });
    const newer = baseOrder({ orderId: 'order-new', createdAt: now });
    const service = new MerchantOrderService(fakeOrderProvider([older, newer]), foundShopProvider);

    const summaries = await service.listOrders(buildShop());
    expect(summaries.map((s) => s.orderId)).toEqual(['order-new', 'order-old']);
    expect(summaries[0]).toMatchObject({ status: 'pending', itemCount: 1, total: 71 });
  });

  it('skips a malformed order instead of throwing', async () => {
    const malformed = { orderId: 'bad-order', shopId: 'shop-1' /* missing everything else */ };
    const service = new MerchantOrderService(fakeOrderProvider([baseOrder(), malformed]), foundShopProvider);

    const summaries = await service.listOrders(buildShop());
    expect(summaries).toHaveLength(1);
    expect(summaries[0].orderId).toBe('order-1');
  });

  it('skips an order whose shopId does not match the linked customerAppShopId', async () => {
    const wrongShop = baseOrder({ orderId: 'other-shop-order', shopId: 'a-different-shop' });
    const service = new MerchantOrderService(fakeOrderProvider([wrongShop]), foundShopProvider);

    const summaries = await service.listOrders(buildShop());
    expect(summaries).toEqual([]);
  });

  it('throws 409 when the shop has no customerAppShopId mapping', async () => {
    const service = new MerchantOrderService(fakeOrderProvider([]), foundShopProvider);
    const rejection = service.listOrders(buildShop({ customerAppShopId: undefined }));

    await expect(rejection).rejects.toThrow(AppError);
    await expect(rejection).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejection).rejects.toThrow(/not linked/i);
  });

  it('throws a distinct 409 when the linked Customer App shop no longer exists', async () => {
    const missingShopProvider: CustomerAppShopProvider = { getShop: async () => null };
    const service = new MerchantOrderService(fakeOrderProvider([]), missingShopProvider);

    const rejection = service.listOrders(buildShop());
    await expect(rejection).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejection).rejects.toThrow(/no longer exists/i);
  });
});

describe('MerchantOrderService.getOrder', () => {
  it('returns full order detail for an order belonging to the linked shop', async () => {
    const service = new MerchantOrderService(fakeOrderProvider([], { 'order-1': baseOrder() }), foundShopProvider);

    const order = await service.getOrder(buildShop(), 'order-1');
    expect(order).toMatchObject({
      orderId: 'order-1',
      status: 'pending',
      paymentStatus: 'paid',
      total: 71,
      items: [{ productId: 'product-1', name: 'Amul Milk', price: 28, quantity: 2, subtotal: 56 }],
      delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    });
  });

  it('returns null for a nonexistent order', async () => {
    const service = new MerchantOrderService(fakeOrderProvider([], {}), foundShopProvider);
    await expect(service.getOrder(buildShop(), 'missing-order')).resolves.toBeNull();
  });

  it('returns null (not another shop\'s data) for an order belonging to a different shop — cross-shop isolation', async () => {
    const otherShopOrder = baseOrder({ orderId: 'order-2', shopId: 'a-different-shop' });
    const service = new MerchantOrderService(fakeOrderProvider([], { 'order-2': otherShopOrder }), foundShopProvider);

    await expect(service.getOrder(buildShop(), 'order-2')).resolves.toBeNull();
  });

  it('throws (does not silently return null) for a malformed order document', async () => {
    const malformed = { orderId: 'order-3', shopId: 'shop-1' };
    const service = new MerchantOrderService(fakeOrderProvider([], { 'order-3': malformed }), foundShopProvider);

    await expect(service.getOrder(buildShop(), 'order-3')).rejects.toThrow();
  });
});
