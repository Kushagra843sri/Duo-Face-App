import { AppError } from '../../src/middleware/errorHandler';
import { CustomerAddressService } from '../../src/services/customerAddressService';
import { CustomerCatalogService } from '../../src/services/customerCatalogService';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { computeFees, paiseToRupees, rupeesToPaise } from '../../src/services/money';
import type { PlaceOrderBody } from '../../src/types/customerOrder';
import { FakeCustomerStore, inventoryOf, NOW, seed } from '../helpers/customerFixtures';

function setup(stock = 1) {
  const store = new FakeCustomerStore();
  seed(store, stock);
  const orders = new CustomerOrderService(store, () => NOW);
  return { store, orders };
}

const body = (over: Partial<PlaceOrderBody> = {}): PlaceOrderBody => ({
  clientRequestId: 'req-00000001',
  shopId: 'shop-1',
  addressId: 'addr-1',
  paymentMethod: 'cod',
  items: [{ productId: 'p-milk', quantity: 1 }],
  ...over,
});

const qty = (s: FakeCustomerStore, p: string) => s.read('duo_face_inventory', `shop-1__${p}`)!.quantity;

describe('money', () => {
  it('converts rupees to paise exactly and rejects bad prices', () => {
    expect(rupeesToPaise(28.5)).toBe(2850);
    expect(rupeesToPaise(0.1 + 0.2 + 28)).toBe(2830); // float noise does not leak through
    expect(() => rupeesToPaise(-1)).toThrow(AppError);
    expect(() => rupeesToPaise(1.005)).toThrow(AppError); // >2 decimals
    expect(() => rupeesToPaise('28')).toThrow(AppError);
    expect(() => rupeesToPaise(NaN)).toThrow(AppError);
    expect(paiseToRupees(2850)).toBe(28.5);
  });
  it('has no fees for now, behind one function', () => {
    expect(computeFees(100000)).toEqual({ deliveryFeePaise: 0, platformFeePaise: 0 });
  });
});

describe('placeOrder', () => {
  it('prices from the database in paise, decrements stock, writes order + event', async () => {
    const { store, orders } = setup(5);
    const { order, created } = await orders.placeOrder('cust-A', body({ items: [{ productId: 'p-milk', quantity: 3 }, { productId: 'p-bread', quantity: 2 }] }));

    expect(created).toBe(true);
    expect(order.status).toBe('pending');
    expect(order.pricing).toEqual({ subtotalPaise: 3 * 2850 + 2 * 4000, deliveryFeePaise: 0, platformFeePaise: 0, totalPaise: 16550 });
    expect(qty(store, 'p-milk')).toBe(2);
    expect(qty(store, 'p-bread')).toBe(8);

    const raw = store.read('orders', order.orderId)!;
    expect(raw.customerId).toBe('cust-A');
    expect((raw.pricing as { total: number }).total).toBe(165.5); // existing rupee field kept for the merchant side
    expect(store.read('order_events', `${order.orderId}__created`)).toMatchObject({ from: null, to: 'pending', actor: { type: 'customer', id: 'cust-A' } });
  });

  it('two buyers for the last unit: exactly one wins, stock never goes negative', async () => {
    const { store, orders } = setup(1);
    const results = await Promise.allSettled([
      orders.placeOrder('cust-A', body({ clientRequestId: 'req-AAAAAAAA' })),
      orders.placeOrder('cust-B', body({ clientRequestId: 'req-BBBBBBBB' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AppError);
    expect((rejected.reason as AppError).statusCode).toBe(409);
    expect(qty(store, 'p-milk')).toBe(0);
    expect([...store.docs.keys()].filter((k) => k.startsWith('orders/'))).toHaveLength(1);
  });

  it('a failed line aborts the whole order: no partial stock decrement', async () => {
    const { store, orders } = setup(5);
    await expect(
      orders.placeOrder('cust-A', body({ items: [{ productId: 'p-bread', quantity: 2 }, { productId: 'p-milk', quantity: 6 }] }))
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(qty(store, 'p-bread')).toBe(10);
    expect(qty(store, 'p-milk')).toBe(5);
  });

  it('is idempotent per clientRequestId: a retry does not decrement twice', async () => {
    const { store, orders } = setup(5);
    const first = await orders.placeOrder('cust-A', body());
    const retry = await orders.placeOrder('cust-A', body());
    expect(retry.created).toBe(false);
    expect(retry.order.orderId).toBe(first.order.orderId);
    expect(qty(store, 'p-milk')).toBe(4);
  });

  it('merges duplicate lines for the same product', async () => {
    const { store, orders } = setup(5);
    const { order } = await orders.placeOrder('cust-A', body({ items: [{ productId: 'p-milk', quantity: 1 }, { productId: 'p-milk', quantity: 2 }] }));
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(3);
    expect(qty(store, 'p-milk')).toBe(2);
  });

  it('rejects: closed shop, unknown shop, foreign product, out of stock flag, missing inventory, bad address', async () => {
    const { store, orders } = setup(5);
    store.put('products', 'p-other', { shopId: 'shop-2', name: 'Other', price: 10, inStock: true });
    store.put('products', 'p-oos', { shopId: 'shop-1', name: 'Gone', price: 10, inStock: false });
    store.put('products', 'p-noinv', { shopId: 'shop-1', name: 'NoInv', price: 10, inStock: true });
    const p = (productId: string) => body({ items: [{ productId, quantity: 1 }] });

    await expect(orders.placeOrder('cust-A', p('p-other'))).rejects.toMatchObject({ statusCode: 404 });
    await expect(orders.placeOrder('cust-A', p('p-oos'))).rejects.toMatchObject({ statusCode: 409 });
    await expect(orders.placeOrder('cust-A', p('p-noinv'))).rejects.toMatchObject({ statusCode: 409 });
    await expect(orders.placeOrder('cust-A', body({ shopId: 'nope' }))).rejects.toMatchObject({ statusCode: 404 });
    await expect(orders.placeOrder('cust-A', body({ addressId: 'nope' }))).rejects.toMatchObject({ statusCode: 404 });
    // another customer's address is invisible to me
    store.put('users/cust-B/addresses', 'addr-B', { label: 'x', fullAddress: 'secret place', phoneNumber: '9999999999' });
    await expect(orders.placeOrder('cust-A', body({ addressId: 'addr-B' }))).rejects.toMatchObject({ statusCode: 404 });

    store.put('shops', 'shop-1', { name: 'Kirana One', isOpen: false, isActive: true });
    await expect(orders.placeOrder('cust-A', body())).rejects.toMatchObject({ statusCode: 409 });
    expect(qty(store, 'p-milk')).toBe(5);
  });

  it('rejects a product with a malformed price instead of guessing', async () => {
    const { store, orders } = setup(5);
    store.put('products', 'p-milk', { shopId: 'shop-1', name: 'Milk', price: '28', inStock: true });
    await expect(orders.placeOrder('cust-A', body())).rejects.toMatchObject({ statusCode: 409 });
    expect(qty(store, 'p-milk')).toBe(5);
  });
});

describe('ownership', () => {
  it("another customer cannot read or cancel my order, and gets the same 404 as a missing one", async () => {
    const { orders } = setup(5);
    const { order } = await orders.placeOrder('cust-A', body());
    await expect(orders.getOrder('cust-B', order.orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(orders.cancelOrder('cust-B', order.orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(orders.getOrder('cust-A', 'missing')).rejects.toMatchObject({ statusCode: 404 });
    expect((await orders.getOrder('cust-A', order.orderId)).orderId).toBe(order.orderId);
  });

  it('listOrders returns only my orders, newest first', async () => {
    const { orders } = setup(9);
    await orders.placeOrder('cust-A', body({ clientRequestId: 'req-00000001' }));
    await orders.placeOrder('cust-B', body({ clientRequestId: 'req-00000002' }));
    const mine = await orders.listOrders('cust-A');
    expect(mine).toHaveLength(1);
    expect(mine[0].orderId).toBe('ord_cust-A_req-00000001');
  });
});

describe('cancelOrder', () => {
  it('cancels a pending order, restores stock, writes an event; repeat is idempotent', async () => {
    const { store, orders } = setup(5);
    const { order } = await orders.placeOrder('cust-A', body({ items: [{ productId: 'p-milk', quantity: 2 }] }));
    expect(qty(store, 'p-milk')).toBe(3);

    const cancelled = await orders.cancelOrder('cust-A', order.orderId);
    expect(cancelled.status).toBe('cancelled');
    expect(qty(store, 'p-milk')).toBe(5);
    expect(store.read('order_events', `${order.orderId}__pending_cancelled`)).toMatchObject({ from: 'pending', to: 'cancelled' });

    await orders.cancelOrder('cust-A', order.orderId);
    expect(qty(store, 'p-milk')).toBe(5); // not restored twice
  });

  it.each(['confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'rejected'])(
    'refuses to cancel once %s and does not touch stock',
    async (status) => {
      const { store, orders } = setup(5);
      const { order } = await orders.placeOrder('cust-A', body());
      store.put('orders', order.orderId, { ...store.read('orders', order.orderId)!, status });
      await expect(orders.cancelOrder('cust-A', order.orderId)).rejects.toMatchObject({ statusCode: 409 });
      expect(qty(store, 'p-milk')).toBe(4);
    }
  );
});

describe('catalog', () => {
  it('lists only orderable products with paise prices and available quantity', async () => {
    const { store } = setup(5);
    store.put('products', 'p-hidden', { shopId: 'shop-1', name: 'Hidden', price: 5, inStock: true, isActive: false });
    store.put('products', 'p-noinv', { shopId: 'shop-1', name: 'NoInv', price: 5, inStock: true });
    const catalog = new CustomerCatalogService(store, inventoryOf(store));
    const list = await catalog.listProducts('shop-1');
    expect(list.map((p) => p.productId)).toEqual(['p-bread', 'p-milk']);
    expect(list.find((p) => p.productId === 'p-milk')).toMatchObject({ pricePaise: 2850, available: 5 });
  });

  it('hides sold-out products and inactive shops', async () => {
    const { store } = setup(0);
    const catalog = new CustomerCatalogService(store, inventoryOf(store));
    expect((await catalog.listProducts('shop-1')).map((p) => p.productId)).toEqual(['p-bread']);
    store.put('shops', 'shop-9', { name: 'Closed down', isActive: false });
    await expect(catalog.listProducts('shop-9')).rejects.toMatchObject({ statusCode: 404 });
    expect((await catalog.listShops()).map((s) => s.shopId)).toEqual(['shop-1']);
  });
});

describe('addresses', () => {
  it('first address becomes default; a new default replaces it; deleting the default promotes another', async () => {
    const store = new FakeCustomerStore();
    const svc = new CustomerAddressService(store);
    const a = await svc.create('u1', { label: 'Home', fullAddress: '1 Main Road', phoneNumber: '9876543210' });
    expect(a.isDefault).toBe(true);
    const b = await svc.create('u1', { label: 'Work', fullAddress: '2 Office Park', phoneNumber: '9876543210', isDefault: true });
    expect((await svc.list('u1')).map((x) => [x.label, x.isDefault])).toEqual([['Work', true], ['Home', false]]);
    await svc.remove('u1', b.addressId);
    expect((await svc.list('u1'))[0]).toMatchObject({ label: 'Home', isDefault: true });
  });

  it("is scoped to the caller: cannot update or delete another user's address", async () => {
    const store = new FakeCustomerStore();
    const svc = new CustomerAddressService(store);
    const a = await svc.create('u1', { label: 'Home', fullAddress: '1 Main Road', phoneNumber: '9876543210' });
    await expect(svc.update('u2', a.addressId, { label: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.remove('u2', a.addressId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('caps the address book', async () => {
    const store = new FakeCustomerStore();
    const svc = new CustomerAddressService(store);
    for (let i = 0; i < 10; i++) await svc.create('u1', { label: `L${i}`, fullAddress: '1 Main Road', phoneNumber: '9876543210' });
    await expect(svc.create('u1', { label: 'one more', fullAddress: '1 Main Road', phoneNumber: '9876543210' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
