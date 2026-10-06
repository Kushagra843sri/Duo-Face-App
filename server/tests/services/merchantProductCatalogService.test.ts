import { MerchantProductCatalogService } from '../../src/services/merchantProductCatalogService';
import { InventoryService } from '../../src/services/inventoryService';
import { AppError } from '../../src/middleware/errorHandler';
import type { CustomerAppProductProvider } from '../../src/integrations/customerApp/CustomerAppProductProvider';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import type { InventoryStore } from '../../src/integrations/firebase/FirestoreInventoryStore';
import type { CustomerAppInventoryProvider } from '../../src/integrations/customerApp/CustomerAppInventoryProvider';
import type { DuoFaceShop } from '../../src/types/duoFaceShop';

function createFakeInventoryStore(initial: Record<string, Record<string, unknown>> = {}): InventoryStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(id) {
      return data.get(id) ?? null;
    },
    async set(id, value) {
      data.set(id, value);
    },
    async listByShopId(shopId) {
      return [...data.values()].filter((v) => v.shopId === shopId);
    },
    async runTransaction(id, updater) {
      const current = data.get(id) ?? null;
      const next = updater(current);
      data.set(id, next);
      return next;
    },
  };
}

const unusedProductLookup: CustomerAppInventoryProvider = {
  getProduct: async () => {
    throw new Error('not used');
  },
  getStock: async () => {
    throw new Error('not used');
  },
  adjustStock: async () => {
    throw new Error('not used');
  },
};

function fakeProductProvider(products: unknown[]): CustomerAppProductProvider {
  return { listProductsByShopId: async () => products };
}

// The linked Customer App shop ('shop-1') is found by default — most tests
// are about product-joining behavior, not the link-verification step
// itself (that has its own dedicated tests below).
const foundShopProvider: CustomerAppShopProvider = {
  getShop: async (id) => (id === 'shop-1' ? { id: 'shop-1', name: 'Sharma Kirana' } : null),
};

const now = new Date();

// Duo-Face shopId is deliberately different from the Customer App shopId
// used on the fake products below, to prove the query uses
// customerAppShopId, not the Duo-Face shop's own id.
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

describe('MerchantProductCatalogService.listCatalog — linked shop, product joining', () => {
  it('returns a product with inventory: null when no Duo-Face inventory record exists', async () => {
    const productProvider = fakeProductProvider([
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
    ]);
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(productProvider, inventoryService, foundShopProvider);

    const entries = await service.listCatalog(buildShop());
    expect(entries).toEqual([
      { productId: 'product-1', name: 'Amul Milk', description: null, price: 28, inStock: true, isActive: true, inventory: null },
    ]);
  });

  it('attaches Duo-Face inventory (keyed by the customer-facing shop id, the one customers use) when a matching record exists', async () => {
    const productProvider = fakeProductProvider([
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
    ]);
    const inventoryStore = createFakeInventoryStore({
      'shop-1__product-1': {
        inventoryId: 'shop-1__product-1',
        shopId: 'shop-1',
        productId: 'product-1',
        quantity: 40,
        reservedQuantity: 5,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    const inventoryService = new InventoryService(inventoryStore, unusedProductLookup);
    const service = new MerchantProductCatalogService(productProvider, inventoryService, foundShopProvider);

    const entries = await service.listCatalog(buildShop());
    expect(entries).toEqual([
      {
        productId: 'product-1',
        name: 'Amul Milk',
        price: 28,
        inStock: true,
        description: null,
        isActive: true,
        inventory: { quantity: 40, reservedQuantity: 5, status: 'active' },
      },
    ]);
  });

  it('skips a malformed Customer App product instead of throwing', async () => {
    const productProvider = fakeProductProvider([
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
      { id: 'product-2', shopId: 'shop-1' /* missing name/price/inStock */ },
    ]);
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(productProvider, inventoryService, foundShopProvider);

    const entries = await service.listCatalog(buildShop());
    expect(entries).toHaveLength(1);
    expect(entries[0].productId).toBe('product-1');
  });

  it('skips a product whose shopId does not actually match the shop\'s customerAppShopId', async () => {
    const productProvider = fakeProductProvider([
      { id: 'product-1', shopId: 'a-different-shop', name: 'X', price: 1, inStock: true },
    ]);
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(productProvider, inventoryService, foundShopProvider);

    const entries = await service.listCatalog(buildShop());
    expect(entries).toEqual([]);
  });

  it('returns an empty list when the (linked, existing) shop genuinely has no products', async () => {
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(fakeProductProvider([]), inventoryService, foundShopProvider);

    await expect(service.listCatalog(buildShop())).resolves.toEqual([]);
  });
});

describe('MerchantProductCatalogService.listCatalog — unlinked / broken-link failures', () => {
  it('throws a 409 (never a silent empty list) when customerAppShopId is not set, without ever querying products', async () => {
    const throwingProductProvider: CustomerAppProductProvider = {
      listProductsByShopId: async () => {
        throw new Error('listProductsByShopId must not be called when customerAppShopId is unset');
      },
    };
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(throwingProductProvider, inventoryService, foundShopProvider);

    const unlinkedShop = buildShop({ customerAppShopId: undefined });
    const rejection = service.listCatalog(unlinkedShop);

    await expect(rejection).rejects.toThrow(AppError);
    await expect(rejection).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejection).rejects.toThrow(/not linked/i);
  });

  it('throws a distinct 409 when customerAppShopId is set but the linked Customer App shop no longer exists', async () => {
    const missingShopProvider: CustomerAppShopProvider = { getShop: async () => null };
    const throwingProductProvider: CustomerAppProductProvider = {
      listProductsByShopId: async () => {
        throw new Error('listProductsByShopId must not be called when the linked shop is missing');
      },
    };
    const inventoryService = new InventoryService(createFakeInventoryStore(), unusedProductLookup);
    const service = new MerchantProductCatalogService(throwingProductProvider, inventoryService, missingShopProvider);

    const rejection = service.listCatalog(buildShop());

    await expect(rejection).rejects.toThrow(AppError);
    await expect(rejection).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejection).rejects.toThrow(/no longer exists/i);
    // Distinct from the "not linked" message — a caller can tell these apart.
    await expect(rejection).rejects.not.toThrow(/not linked/i);
  });
});
