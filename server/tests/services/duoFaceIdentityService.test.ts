import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';

function createFakeStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceIdentityStore {
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

describe('DuoFaceIdentityService.getByFirebaseUid', () => {
  it('returns null when no identity document exists', async () => {
    const service = new DuoFaceIdentityService(createFakeStore());
    await expect(service.getByFirebaseUid('missing-uid')).resolves.toBeNull();
  });

  it('returns a validated active merchant identity', async () => {
    const store = createFakeStore({
      'merchant-uid': {
        firebaseUid: 'merchant-uid',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const identity = await new DuoFaceIdentityService(store).getByFirebaseUid('merchant-uid');
    expect(identity).toMatchObject({ role: 'merchant', status: 'active', merchant: { shopId: 'shop-1' } });
  });

  it('returns a validated active driver identity', async () => {
    const store = createFakeStore({
      'driver-uid': {
        firebaseUid: 'driver-uid',
        role: 'driver',
        status: 'active',
        driver: { driverId: 'driver-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const identity = await new DuoFaceIdentityService(store).getByFirebaseUid('driver-uid');
    expect(identity).toMatchObject({ role: 'driver', status: 'active', driver: { driverId: 'driver-1' } });
  });

  it('returns a suspended identity as valid data (suspension is the resolver\'s concern, not the service\'s)', async () => {
    const store = createFakeStore({
      'suspended-uid': {
        firebaseUid: 'suspended-uid',
        role: 'merchant',
        status: 'suspended',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const identity = await new DuoFaceIdentityService(store).getByFirebaseUid('suspended-uid');
    expect(identity?.status).toBe('suspended');
  });

  it('throws when an active merchant document is missing shopId', async () => {
    const store = createFakeStore({
      uid: { firebaseUid: 'uid', role: 'merchant', status: 'active', createdAt: new Date(), updatedAt: new Date() },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('uid')).rejects.toThrow();
  });

  it('throws when an active driver document is missing driverId', async () => {
    const store = createFakeStore({
      uid: { firebaseUid: 'uid', role: 'driver', status: 'active', createdAt: new Date(), updatedAt: new Date() },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('uid')).rejects.toThrow();
  });

  it('throws when both merchant and driver mappings are present', async () => {
    const store = createFakeStore({
      uid: {
        firebaseUid: 'uid',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        driver: { driverId: 'driver-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('uid')).rejects.toThrow();
  });

  it('throws on an unsupported role value', async () => {
    const store = createFakeStore({
      uid: { firebaseUid: 'uid', role: 'admin', status: 'active', createdAt: new Date(), updatedAt: new Date() },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('uid')).rejects.toThrow();
  });

  it('throws on an unknown status value', async () => {
    const store = createFakeStore({
      uid: {
        firebaseUid: 'uid',
        role: 'merchant',
        status: 'pending',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('uid')).rejects.toThrow();
  });

  it('throws when the document firebaseUid does not match the lookup key', async () => {
    const store = createFakeStore({
      'lookup-uid': {
        firebaseUid: 'different-uid',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await expect(new DuoFaceIdentityService(store).getByFirebaseUid('lookup-uid')).rejects.toThrow();
  });
});

describe('DuoFaceIdentityService.provisionIdentity', () => {
  it('provisions an active merchant identity', async () => {
    const service = new DuoFaceIdentityService(createFakeStore());
    const identity = await service.provisionIdentity({ firebaseUid: 'uid-1', role: 'merchant', shopId: 'shop-1' });

    expect(identity).toMatchObject({
      firebaseUid: 'uid-1',
      role: 'merchant',
      status: 'active',
      merchant: { shopId: 'shop-1' },
    });
    await expect(service.getByFirebaseUid('uid-1')).resolves.toMatchObject({ role: 'merchant' });
  });

  it('provisions an active driver identity', async () => {
    const service = new DuoFaceIdentityService(createFakeStore());
    const identity = await service.provisionIdentity({ firebaseUid: 'uid-2', role: 'driver', driverId: 'driver-1' });

    expect(identity).toMatchObject({
      firebaseUid: 'uid-2',
      role: 'driver',
      status: 'active',
      driver: { driverId: 'driver-1' },
    });
    await expect(service.getByFirebaseUid('uid-2')).resolves.toMatchObject({ role: 'driver' });
  });

  it('rejects a provisioning input missing shopId for a merchant', async () => {
    const service = new DuoFaceIdentityService(createFakeStore());
    await expect(
      service.provisionIdentity({ firebaseUid: 'uid-3', role: 'merchant', shopId: '' })
    ).rejects.toThrow();
  });
});
