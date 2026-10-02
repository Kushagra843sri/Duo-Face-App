import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import type { DeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { MerchantProvisioningService } from '../../src/services/merchantProvisioningService';
import type { DuoFaceProvisioningTransaction } from '../../src/services/merchantProvisioningService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';

function createFakeIdentityStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceIdentityStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(firebaseUid) {
      return data.get(firebaseUid) ?? null;
    },
    async set(firebaseUid, value) {
      data.set(firebaseUid, value);
    },
  };
}

function createFakeShopStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceShopStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(shopId) {
      return data.get(shopId) ?? null;
    },
    async set(shopId, value) {
      data.set(shopId, value);
    },
    async findByCustomerAppShopId(customerAppShopId) {
      for (const v of data.values()) if (v.customerAppShopId === customerAppShopId) return v;
      return null;
    },
    async findByMerchantFirebaseUid(merchantFirebaseUid) {
      for (const value of data.values()) {
        if (value.merchantFirebaseUid === merchantFirebaseUid) return value;
      }
      return null;
    },
  };
}

// Simulates atomicity for test purposes by writing to both fake stores
// sequentially — real atomicity is Firestore's own transaction guarantee,
// exercised in production (FirestoreDuoFaceProvisioningTransaction), not
// re-implemented here.
function createFakeTransaction(
  identityStore: DuoFaceIdentityStore,
  shopStore: DuoFaceShopStore
): DuoFaceProvisioningTransaction {
  return {
    async runAtomic({ identityFirebaseUid, identityData, shopId, shopData }) {
      await identityStore.set(identityFirebaseUid, identityData);
      await shopStore.set(shopId, shopData);
    },
  };
}

const notFoundCustomerAppShopProvider: CustomerAppShopProvider = {
  getShop: async () => null,
};

function fakeCustomerAppShopProvider(shops: Record<string, unknown>): CustomerAppShopProvider {
  return { getShop: async (id) => shops[id] ?? null };
}

function buildService(
  identityStore = createFakeIdentityStore(),
  shopStore = createFakeShopStore(),
  customerAppShopProvider: CustomerAppShopProvider = notFoundCustomerAppShopProvider,
  geocoder: DeliveryGeocoder = { geocode: async () => null }
) {
  const identityService = new DuoFaceIdentityService(identityStore);
  const shopService = new DuoFaceShopService(shopStore);
  const transaction = createFakeTransaction(identityStore, shopStore);
  return {
    service: new MerchantProvisioningService(identityService, shopService, transaction, customerAppShopProvider, geocoder),
    identityService,
    shopService,
  };
}

describe('MerchantProvisioningService.provisionMerchantShop', () => {
  it('creates a linked merchant identity and shop', async () => {
    const { service, identityService, shopService } = buildService();

    const result = await service.provisionMerchantShop({ firebaseUid: 'uid-1', shopId: 'shop-1', name: 'Sharma Kirana' });

    expect(result.identity).toMatchObject({ firebaseUid: 'uid-1', role: 'merchant', merchant: { shopId: 'shop-1' } });
    expect(result.shop).toMatchObject({ shopId: 'shop-1', name: 'Sharma Kirana', merchantFirebaseUid: 'uid-1' });

    // Atomic cross-reference: both documents are independently readable and consistent.
    await expect(identityService.getByFirebaseUid('uid-1')).resolves.toMatchObject({ merchant: { shopId: 'shop-1' } });
    await expect(shopService.getById('shop-1')).resolves.toMatchObject({ merchantFirebaseUid: 'uid-1' });
  });

  it('rejects when an identity already exists for the firebaseUid (duplicate merchant)', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'driver',
        status: 'active',
        driver: { driverId: 'driver-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { service } = buildService(identityStore);

    await expect(
      service.provisionMerchantShop({ firebaseUid: 'uid-1', shopId: 'shop-1', name: 'X' })
    ).rejects.toThrow(/identity already exists/i);
  });

  it('rejects when a shop already exists at the requested shopId (duplicate shop)', async () => {
    const shopStore = createFakeShopStore({
      'shop-1': {
        shopId: 'shop-1',
        name: 'Existing',
        status: 'active',
        merchantFirebaseUid: 'someone-else',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { service } = buildService(undefined, shopStore);

    await expect(
      service.provisionMerchantShop({ firebaseUid: 'uid-1', shopId: 'shop-1', name: 'X' })
    ).rejects.toThrow(/shop already exists/i);
  });

  it('rejects when a shop already references this merchantFirebaseUid under a different shopId (inconsistent existing shop)', async () => {
    const shopStore = createFakeShopStore({
      'other-shop': {
        shopId: 'other-shop',
        name: 'Orphaned',
        status: 'active',
        merchantFirebaseUid: 'uid-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { service } = buildService(undefined, shopStore);

    await expect(
      service.provisionMerchantShop({ firebaseUid: 'uid-1', shopId: 'new-shop', name: 'X' })
    ).rejects.toThrow(/already references merchantFirebaseUid/i);
  });

  it('accepts and stores a customerAppShopId once verified to exist', async () => {
    const customerAppShopProvider = fakeCustomerAppShopProvider({
      'allz-bharat-shop-456': { id: 'allz-bharat-shop-456', name: 'Sharma Kirana' },
    });
    const { service, shopService } = buildService(undefined, undefined, customerAppShopProvider);

    const result = await service.provisionMerchantShop({
      firebaseUid: 'uid-1',
      shopId: 'shop-1',
      name: 'Sharma Kirana',
      customerAppShopId: 'allz-bharat-shop-456',
    });

    expect(result.shop.customerAppShopId).toBe('allz-bharat-shop-456');
    await expect(shopService.getById('shop-1')).resolves.toMatchObject({ customerAppShopId: 'allz-bharat-shop-456' });
  });

  it('rejects a customerAppShopId that does not exist in the Customer App', async () => {
    const { service } = buildService(undefined, undefined, notFoundCustomerAppShopProvider);

    await expect(
      service.provisionMerchantShop({
        firebaseUid: 'uid-1',
        shopId: 'shop-1',
        name: 'X',
        customerAppShopId: 'does-not-exist',
      })
    ).rejects.toThrow(/no Customer App shop exists/i);
  });

  it('rejects a malformed Customer App shop document', async () => {
    const customerAppShopProvider = fakeCustomerAppShopProvider({
      'malformed-shop': { id: 'malformed-shop' /* missing name */ },
    });
    const { service } = buildService(undefined, undefined, customerAppShopProvider);

    await expect(
      service.provisionMerchantShop({
        firebaseUid: 'uid-1',
        shopId: 'shop-1',
        name: 'X',
        customerAppShopId: 'malformed-shop',
      })
    ).rejects.toThrow(/malformed/i);
  });

  it('propagates a transaction failure and leaves nothing reported as succeeded', async () => {
    const identityService = new DuoFaceIdentityService(createFakeIdentityStore());
    const shopService = new DuoFaceShopService(createFakeShopStore());
    const failingTransaction: DuoFaceProvisioningTransaction = {
      runAtomic: async () => {
        throw new Error('simulated Firestore transaction failure');
      },
    };
    const service = new MerchantProvisioningService(identityService, shopService, failingTransaction);

    await expect(
      service.provisionMerchantShop({ firebaseUid: 'uid-1', shopId: 'shop-1', name: 'X' })
    ).rejects.toThrow(/simulated Firestore transaction failure/);

    // Neither document should be visible afterwards.
    await expect(identityService.getByFirebaseUid('uid-1')).resolves.toBeNull();
    await expect(shopService.getById('shop-1')).resolves.toBeNull();
  });
});

describe('pickup location at setup time', () => {
  const linked = { 'cust-shop-1': { id: 'cust-shop-1', name: 'Fresh Mart', address: '1 Connaught Place, New Delhi' } };
  const CP = { latitude: 28.6315, longitude: 77.2167 };

  it('stores an explicit pickupLocation exactly as given, without geocoding', async () => {
    const geocode = jest.fn(async () => ({ latitude: 1, longitude: 1 }));
    const { service, shopService } = buildService(undefined, undefined, fakeCustomerAppShopProvider(linked), { geocode });
    const result = await service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X', customerAppShopId: 'cust-shop-1', pickupLocation: CP });
    expect(result.shop.pickupLocation).toEqual(CP);
    expect(geocode).not.toHaveBeenCalled();
    await expect(shopService.getById('s')).resolves.toMatchObject({ pickupLocation: CP });
  });

  it('geocodes the linked Customer App shop address once and stores the result', async () => {
    const geocode = jest.fn(async () => CP);
    const { service, shopService } = buildService(undefined, undefined, fakeCustomerAppShopProvider(linked), { geocode });
    await service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X', customerAppShopId: 'cust-shop-1' });
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledWith('1 Connaught Place, New Delhi');
    await expect(shopService.getById('s')).resolves.toMatchObject({ pickupLocation: CP });
  });

  it('still provisions (without a location) when geocoding finds nothing or throws', async () => {
    const failing: Array<() => Promise<null>> = [
      async () => null,
      async () => {
        throw new Error('down');
      },
    ];
    for (const geocode of failing) {
      const { service, shopService } = buildService(undefined, undefined, fakeCustomerAppShopProvider(linked), { geocode });
      await service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X', customerAppShopId: 'cust-shop-1' });
      expect((await shopService.getById('s'))?.pickupLocation).toBeUndefined();
    }
  });

  it('does not geocode when no Customer App shop is linked', async () => {
    const geocode = jest.fn(async () => CP);
    const { service } = buildService(undefined, undefined, undefined, { geocode });
    const result = await service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X' });
    expect(result.shop.pickupLocation).toBeUndefined();
    expect(geocode).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit coordinates', async () => {
    const { service } = buildService();
    await expect(
      service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X', pickupLocation: { latitude: 120, longitude: 0 } })
    ).rejects.toThrow();
  });

  it('backfillPickupLocation stores the geocoded address on an existing shop, and is a no-op when it cannot be resolved', async () => {
    const shopStore = createFakeShopStore();
    const first = buildService(undefined, shopStore, fakeCustomerAppShopProvider(linked), { geocode: async () => null });
    await first.service.provisionMerchantShop({ firebaseUid: 'u', shopId: 's', name: 'X', customerAppShopId: 'cust-shop-1' });
    await expect(first.service.backfillPickupLocation('s')).resolves.toBeNull();

    const second = new MerchantProvisioningService(
      first.identityService,
      first.shopService,
      createFakeTransaction(createFakeIdentityStore(), shopStore),
      fakeCustomerAppShopProvider(linked),
      { geocode: async () => CP }
    );
    await expect(second.backfillPickupLocation('s')).resolves.toEqual(CP);
    await expect(first.shopService.getById('s')).resolves.toMatchObject({ pickupLocation: CP, name: 'X' });
    await expect(second.backfillPickupLocation('missing')).rejects.toThrow();
  });
});
