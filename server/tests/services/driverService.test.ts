import { DriverService } from '../../src/services/driverService';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';

function createFakeStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceDriverStore {
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

describe('DriverService', () => {
  it('creates a driver and reads it back by id', async () => {
    const service = new DriverService(createFakeStore());

    const created = await service.createDriver({ driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Ravi Kumar' });
    expect(created).toMatchObject({ driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Ravi Kumar', status: 'active' });

    await expect(service.getById('driver-1')).resolves.toMatchObject({ driverId: 'driver-1' });
  });

  it('creates a driver with an optional phoneNumber', async () => {
    const service = new DriverService(createFakeStore());

    const created = await service.createDriver({
      driverId: 'driver-1',
      firebaseUid: 'uid-1',
      name: 'Ravi Kumar',
      phoneNumber: '+911234567890',
    });

    expect(created.phoneNumber).toBe('+911234567890');
  });

  it('returns null for a nonexistent driver', async () => {
    const service = new DriverService(createFakeStore());
    await expect(service.getById('missing')).resolves.toBeNull();
  });

  it('finds a driver by firebaseUid', async () => {
    const store = createFakeStore({
      'driver-1': {
        driverId: 'driver-1',
        firebaseUid: 'uid-1',
        name: 'Ravi Kumar',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const service = new DriverService(store);

    await expect(service.getByFirebaseUid('uid-1')).resolves.toMatchObject({ driverId: 'driver-1' });
    await expect(service.getByFirebaseUid('uid-unknown')).resolves.toBeNull();
  });

  it('throws when the stored document has a mismatched driverId field', async () => {
    const store = createFakeStore({
      'driver-1': {
        driverId: 'driver-999',
        firebaseUid: 'uid-1',
        name: 'X',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const service = new DriverService(store);

    await expect(service.getById('driver-1')).rejects.toThrow(/mismatched driverId/i);
  });

  it('suspends an existing driver', async () => {
    const store = createFakeStore({
      'driver-1': {
        driverId: 'driver-1',
        firebaseUid: 'uid-1',
        name: 'Ravi Kumar',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const service = new DriverService(store);

    const suspended = await service.suspendDriver('driver-1');
    expect(suspended.status).toBe('suspended');
    await expect(service.getById('driver-1')).resolves.toMatchObject({ status: 'suspended' });
  });

  it('throws when suspending a nonexistent driver', async () => {
    const service = new DriverService(createFakeStore());
    await expect(service.suspendDriver('missing')).rejects.toThrow(/no such driver exists/i);
  });
});
