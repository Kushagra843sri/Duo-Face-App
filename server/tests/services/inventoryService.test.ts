import { InventoryService } from '../../src/services/inventoryService';
import { AppError } from '../../src/middleware/errorHandler';
import type { InventoryStore } from '../../src/integrations/firebase/FirestoreInventoryStore';
import type { CustomerAppInventoryProvider } from '../../src/integrations/customerApp/CustomerAppInventoryProvider';

function createFakeStore(initial: Record<string, Record<string, unknown>> = {}): InventoryStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(inventoryId) {
      return data.get(inventoryId) ?? null;
    },
    async set(inventoryId, value) {
      data.set(inventoryId, value);
    },
    async listByShopId(shopId) {
      return [...data.values()].filter((v) => v.shopId === shopId);
    },
    async runTransaction(inventoryId, updater) {
      // Simulates the same read-updater-write shape as the real Firestore
      // transaction, for test purposes — real atomicity/retry-on-contention
      // is Firestore's own guarantee (FirestoreInventoryStore), not
      // re-implemented here.
      const current = data.get(inventoryId) ?? null;
      const next = updater(current);
      data.set(inventoryId, next);
      return next;
    },
  };
}

/**
 * A store whose plain get/set throw if called directly — only
 * runTransaction is wired to actually work. If adjustQuantity/setQuantity
 * ever fell back to an unsafe get-then-set instead of the transactional
 * path, these tests would fail with that thrown error instead of the
 * expected result.
 */
function createTransactionOnlyStore(initial: Record<string, Record<string, unknown>>): InventoryStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async () => {
      throw new Error('get() must not be called directly by adjustQuantity/setQuantity');
    },
    set: async () => {
      throw new Error('set() must not be called directly by adjustQuantity/setQuantity');
    },
    listByShopId: async () => [...data.values()],
    runTransaction: async (inventoryId, updater) => {
      const current = data.get(inventoryId) ?? null;
      const next = updater(current);
      data.set(inventoryId, next);
      return next;
    },
  };
}

const foundProductLookup: CustomerAppInventoryProvider = {
  getProduct: async () => ({ id: 'product-1', name: 'Some Product' }),
  getStock: async () => {
    throw new Error('not used in these tests');
  },
  adjustStock: async () => {
    throw new Error('not used in these tests');
  },
};

const notFoundProductLookup: CustomerAppInventoryProvider = {
  ...foundProductLookup,
  getProduct: async () => null,
};

function activeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    inventoryId: 'shop-1__product-1',
    shopId: 'shop-1',
    productId: 'product-1',
    quantity: 10,
    reservedQuantity: 0,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('InventoryService.createInventory', () => {
  it('creates inventory when the product exists in the Customer App', async () => {
    const service = new InventoryService(createFakeStore(), foundProductLookup);
    const item = await service.createInventory('shop-1', 'product-1', 10);

    expect(item).toMatchObject({ shopId: 'shop-1', productId: 'product-1', quantity: 10, reservedQuantity: 0, status: 'active' });
  });

  it('rejects when inventory already exists for the shop/product pair', async () => {
    const store = createFakeStore({ 'shop-1__product-1': activeItem() });
    const service = new InventoryService(store, foundProductLookup);

    await expect(service.createInventory('shop-1', 'product-1', 5)).rejects.toThrow(AppError);
  });

  it('rejects when the product does not exist in the Customer App', async () => {
    const service = new InventoryService(createFakeStore(), notFoundProductLookup);
    await expect(service.createInventory('shop-1', 'unknown-product', 5)).rejects.toThrow(AppError);
  });
});

describe('InventoryService.getInventory / listInventory', () => {
  it('returns null when no inventory exists', async () => {
    const service = new InventoryService(createFakeStore(), foundProductLookup);
    await expect(service.getInventory('shop-1', 'product-1')).resolves.toBeNull();
  });

  it('lists only the requesting shop\'s inventory', async () => {
    const store = createFakeStore({
      'shop-1__product-1': activeItem(),
      'shop-2__product-1': activeItem({ inventoryId: 'shop-2__product-1', shopId: 'shop-2' }),
    });
    const service = new InventoryService(store, foundProductLookup);

    const items = await service.listInventory('shop-1');
    expect(items).toHaveLength(1);
    expect(items[0].shopId).toBe('shop-1');
  });

  it('throws on a malformed stored document', async () => {
    const store = createFakeStore({ 'shop-1__product-1': activeItem({ status: 'archived' }) });
    const service = new InventoryService(store, foundProductLookup);
    await expect(service.getInventory('shop-1', 'product-1')).rejects.toThrow();
  });
});

describe('InventoryService.setQuantity', () => {
  it('sets the quantity via the transactional path', async () => {
    const store = createTransactionOnlyStore({ 'shop-1__product-1': activeItem({ quantity: 10 }) });
    const service = new InventoryService(store, foundProductLookup);

    const item = await service.setQuantity('shop-1', 'product-1', 25);
    expect(item.quantity).toBe(25);
  });

  it('rejects setting quantity below reservedQuantity', async () => {
    const store = createTransactionOnlyStore({
      'shop-1__product-1': activeItem({ quantity: 10, reservedQuantity: 8 }),
    });
    const service = new InventoryService(store, foundProductLookup);

    await expect(service.setQuantity('shop-1', 'product-1', 5)).rejects.toThrow(AppError);
  });

  it('rejects when inventory does not exist', async () => {
    const service = new InventoryService(createTransactionOnlyStore({}), foundProductLookup);
    await expect(service.setQuantity('shop-1', 'missing-product', 5)).rejects.toThrow(AppError);
  });

  it('rejects modifying disabled inventory', async () => {
    const store = createTransactionOnlyStore({ 'shop-1__product-1': activeItem({ status: 'disabled' }) });
    const service = new InventoryService(store, foundProductLookup);
    await expect(service.setQuantity('shop-1', 'product-1', 5)).rejects.toThrow(AppError);
  });
});

describe('InventoryService.adjustQuantity', () => {
  it('adjusts the quantity via the transactional path (never a direct get/set)', async () => {
    const store = createTransactionOnlyStore({ 'shop-1__product-1': activeItem({ quantity: 10 }) });
    const service = new InventoryService(store, foundProductLookup);

    const item = await service.adjustQuantity('shop-1', 'product-1', -3);
    expect(item.quantity).toBe(7);
  });

  it('rejects an adjustment that would make quantity negative', async () => {
    const store = createTransactionOnlyStore({ 'shop-1__product-1': activeItem({ quantity: 10 }) });
    const service = new InventoryService(store, foundProductLookup);

    await expect(service.adjustQuantity('shop-1', 'product-1', -11)).rejects.toThrow(AppError);
  });

  it('rejects an adjustment that would drop quantity below reservedQuantity', async () => {
    const store = createTransactionOnlyStore({
      'shop-1__product-1': activeItem({ quantity: 10, reservedQuantity: 6 }),
    });
    const service = new InventoryService(store, foundProductLookup);

    await expect(service.adjustQuantity('shop-1', 'product-1', -5)).rejects.toThrow(AppError);
  });

  it('rejects adjusting disabled inventory', async () => {
    const store = createTransactionOnlyStore({ 'shop-1__product-1': activeItem({ status: 'disabled' }) });
    const service = new InventoryService(store, foundProductLookup);
    await expect(service.adjustQuantity('shop-1', 'product-1', 1)).rejects.toThrow(AppError);
  });
});

describe('InventoryService.disableInventory', () => {
  it('disables an existing inventory record without deleting it', async () => {
    const store = createFakeStore({ 'shop-1__product-1': activeItem() });
    const service = new InventoryService(store, foundProductLookup);

    const disabled = await service.disableInventory('shop-1', 'product-1');
    expect(disabled.status).toBe('disabled');
    await expect(service.getInventory('shop-1', 'product-1')).resolves.toMatchObject({ status: 'disabled' });
  });

  it('rejects disabling inventory that does not exist', async () => {
    const service = new InventoryService(createFakeStore(), foundProductLookup);
    await expect(service.disableInventory('shop-1', 'missing-product')).rejects.toThrow(AppError);
  });
});
