import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';

function createFakeStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceShopStore {
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

describe('DuoFaceShopService.createShop / getById', () => {
  it('creates a shop and retrieves it by id', async () => {
    const service = new DuoFaceShopService(createFakeStore());
    const shop = await service.createShop({ shopId: 'shop-1', name: 'Sharma Kirana', merchantFirebaseUid: 'uid-1' });

    expect(shop).toMatchObject({ shopId: 'shop-1', name: 'Sharma Kirana', status: 'active', merchantFirebaseUid: 'uid-1' });
    await expect(service.getById('shop-1')).resolves.toMatchObject({ shopId: 'shop-1' });
  });

  it('returns null when no shop exists', async () => {
    const service = new DuoFaceShopService(createFakeStore());
    await expect(service.getById('missing-shop')).resolves.toBeNull();
  });

  it('throws on a malformed stored document', async () => {
    const store = createFakeStore({
      'shop-1': { shopId: 'shop-1', name: 'X', status: 'archived', merchantFirebaseUid: 'uid-1' },
    });
    await expect(new DuoFaceShopService(store).getById('shop-1')).rejects.toThrow();
  });

  it('throws when the document shopId does not match the lookup key', async () => {
    const store = createFakeStore({
      'lookup-id': {
        shopId: 'different-id',
        name: 'X',
        status: 'active',
        merchantFirebaseUid: 'uid-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await expect(new DuoFaceShopService(store).getById('lookup-id')).rejects.toThrow();
  });

  // Note: createShop() itself does not reject a duplicate shopId — it's a
  // direct, single-collection write that overwrites. Rejecting a genuine
  // duplicate at provisioning time is MerchantProvisioningService's job
  // (it checks getById() before ever calling createShop()) — see
  // merchantProvisioningService.test.ts.
});

describe('DuoFaceShopService.getByMerchantFirebaseUid', () => {
  it('finds a shop by its merchant firebaseUid', async () => {
    const store = createFakeStore({
      'shop-1': {
        shopId: 'shop-1',
        name: 'X',
        status: 'active',
        merchantFirebaseUid: 'uid-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const shop = await new DuoFaceShopService(store).getByMerchantFirebaseUid('uid-1');
    expect(shop).toMatchObject({ shopId: 'shop-1' });
  });

  it('returns null when no shop matches', async () => {
    const service = new DuoFaceShopService(createFakeStore());
    await expect(service.getByMerchantFirebaseUid('unknown-uid')).resolves.toBeNull();
  });
});

describe('DuoFaceShopService.suspendShop', () => {
  it('suspends an existing shop', async () => {
    const service = new DuoFaceShopService(createFakeStore());
    await service.createShop({ shopId: 'shop-1', name: 'X', merchantFirebaseUid: 'uid-1' });

    const suspended = await service.suspendShop('shop-1');
    expect(suspended.status).toBe('suspended');
    await expect(service.getById('shop-1')).resolves.toMatchObject({ status: 'suspended' });
  });

  it('throws when suspending a shop that does not exist', async () => {
    const service = new DuoFaceShopService(createFakeStore());
    await expect(service.suspendShop('missing-shop')).rejects.toThrow();
  });
});

describe('DuoFaceShopService pickup location + customerAppShopId lookup', () => {
  const base = { shopId: 'shop-1', name: 'Fresh Mart', status: 'active', merchantFirebaseUid: 'uid-1', customerAppShopId: 'cust-1', createdAt: new Date(), updatedAt: new Date() };

  it('finds a shop by its Customer App shop id', async () => {
    const service = new DuoFaceShopService(createFakeStore({ 'shop-1': base }));
    await expect(service.getByCustomerAppShopId('cust-1')).resolves.toMatchObject({ shopId: 'shop-1' });
    await expect(service.getByCustomerAppShopId('nope')).resolves.toBeNull();
  });

  it('setPickupLocation sets/corrects only the location and updatedAt', async () => {
    const service = new DuoFaceShopService(createFakeStore({ 'shop-1': base }));
    const first = await service.setPickupLocation('shop-1', { latitude: 28.6, longitude: 77.2 });
    expect(first).toMatchObject({ name: 'Fresh Mart', merchantFirebaseUid: 'uid-1', pickupLocation: { latitude: 28.6, longitude: 77.2 } });
    const corrected = await service.setPickupLocation('shop-1', { latitude: 28.7, longitude: 77.3 });
    expect(corrected.pickupLocation).toEqual({ latitude: 28.7, longitude: 77.3 });
  });

  it('setPickupLocation rejects invalid coordinates and unknown shops', async () => {
    const service = new DuoFaceShopService(createFakeStore({ 'shop-1': base }));
    await expect(service.setPickupLocation('shop-1', { latitude: 95, longitude: 0 })).rejects.toThrow();
    await expect(service.setPickupLocation('shop-1', { latitude: 0, longitude: 181 })).rejects.toThrow();
    await expect(service.setPickupLocation('missing', { latitude: 1, longitude: 1 })).rejects.toThrow(/no such shop/);
  });
});
