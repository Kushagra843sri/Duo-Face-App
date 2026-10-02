import { DriverProvisioningService } from '../../src/services/driverProvisioningService';
import type { DriverProvisioningTransaction } from '../../src/services/driverProvisioningService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';

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

function createFakeDriverStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceDriverStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(driverId) {
      return data.get(driverId) ?? null;
    },
    async set(driverId, value) {
      data.set(driverId, value);
    },
    async listByStatus(status) {
      return [...data.values()].filter((v) => v.status === status);
    },
    async findByFirebaseUid(firebaseUid) {
      for (const value of data.values()) {
        if (value.firebaseUid === firebaseUid) return value;
      }
      return null;
    },
  };
}

// Simulates atomicity for test purposes by writing to both fake stores
// sequentially — real atomicity is Firestore's own transaction guarantee,
// exercised in production (FirestoreDriverProvisioningTransaction), not
// re-implemented here.
function createFakeTransaction(
  identityStore: DuoFaceIdentityStore,
  driverStore: DuoFaceDriverStore
): DriverProvisioningTransaction {
  return {
    async runAtomic({ identityFirebaseUid, identityData, driverId, driverData }) {
      await identityStore.set(identityFirebaseUid, identityData);
      await driverStore.set(driverId, driverData);
    },
  };
}

function buildService(identityStore = createFakeIdentityStore(), driverStore = createFakeDriverStore()) {
  const identityService = new DuoFaceIdentityService(identityStore);
  const driverService = new DriverService(driverStore);
  const transaction = createFakeTransaction(identityStore, driverStore);
  return {
    service: new DriverProvisioningService(identityService, driverService, transaction),
    identityService,
    driverService,
  };
}

describe('DriverProvisioningService.provisionDriver', () => {
  it('creates a linked driver identity and profile with a generated driverId', async () => {
    const { service, identityService, driverService } = buildService();

    const result = await service.provisionDriver({ firebaseUid: 'uid-1', name: 'Ravi Kumar' });

    expect(result.identity).toMatchObject({ firebaseUid: 'uid-1', role: 'driver' });
    expect(result.identity.driver?.driverId).toBe(result.driver.driverId);
    expect(result.driver).toMatchObject({ firebaseUid: 'uid-1', name: 'Ravi Kumar', status: 'active' });
    expect(typeof result.driver.driverId).toBe('string');
    expect(result.driver.driverId.length).toBeGreaterThan(0);

    await expect(identityService.getByFirebaseUid('uid-1')).resolves.toMatchObject({
      driver: { driverId: result.driver.driverId },
    });
    await expect(driverService.getById(result.driver.driverId)).resolves.toMatchObject({ firebaseUid: 'uid-1' });
  });

  it('stores an optional phoneNumber', async () => {
    const { service } = buildService();
    const result = await service.provisionDriver({ firebaseUid: 'uid-1', name: 'Ravi Kumar', phoneNumber: '+911234567890' });
    expect(result.driver.phoneNumber).toBe('+911234567890');
  });

  it('rejects when an identity already exists for the firebaseUid', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { service } = buildService(identityStore);

    await expect(service.provisionDriver({ firebaseUid: 'uid-1', name: 'X' })).rejects.toThrow(/identity already exists/i);
  });

  it('rejects when an orphaned driver profile already references this firebaseUid', async () => {
    const driverStore = createFakeDriverStore({
      'driver-orphan': {
        driverId: 'driver-orphan',
        firebaseUid: 'uid-1',
        name: 'Orphaned',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const { service } = buildService(undefined, driverStore);

    await expect(service.provisionDriver({ firebaseUid: 'uid-1', name: 'X' })).rejects.toThrow(
      /already references firebaseUid/i
    );
  });

  it('propagates a transaction failure and leaves nothing reported as succeeded', async () => {
    const identityService = new DuoFaceIdentityService(createFakeIdentityStore());
    const driverService = new DriverService(createFakeDriverStore());
    const failingTransaction: DriverProvisioningTransaction = {
      runAtomic: async () => {
        throw new Error('simulated Firestore transaction failure');
      },
    };
    const service = new DriverProvisioningService(identityService, driverService, failingTransaction);

    await expect(service.provisionDriver({ firebaseUid: 'uid-1', name: 'X' })).rejects.toThrow(
      /simulated Firestore transaction failure/
    );

    await expect(identityService.getByFirebaseUid('uid-1')).resolves.toBeNull();
  });
});
