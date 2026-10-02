import express from 'express';
import request from 'supertest';

import { requireActiveDriver } from '../../src/middleware/requireActiveDriver';
import { DriverService } from '../../src/services/driverService';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { AuthenticatedRequest } from '../../src/types/auth';

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

function buildApp(driverService: DriverService, principal: AuthenticatedRequest['principal']) {
  const app = express();
  app.get(
    '/protected',
    (req: AuthenticatedRequest, _res, next) => {
      req.principal = principal;
      next();
    },
    requireActiveDriver(driverService),
    (req: AuthenticatedRequest, res) => res.json({ driver: req.driver })
  );
  return app;
}

const activeDriverStore = createFakeStore({
  'driver-1': {
    driverId: 'driver-1',
    firebaseUid: 'uid-1',
    name: 'Ravi Kumar',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
});

describe('requireActiveDriver', () => {
  it('calls next() and attaches req.driver for an active, matching driver', async () => {
    const app = buildApp(new DriverService(activeDriverStore), { firebaseUid: 'uid-1', role: 'driver', driverId: 'driver-1' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(200);
    expect(response.body.driver).toMatchObject({ driverId: 'driver-1', status: 'active' });
  });

  it('rejects when the principal has no driverId', async () => {
    const app = buildApp(new DriverService(createFakeStore()), { firebaseUid: 'uid-1', role: 'driver' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the driver does not exist', async () => {
    const app = buildApp(new DriverService(createFakeStore()), { firebaseUid: 'uid-1', role: 'driver', driverId: 'missing' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the driver belongs to a different firebaseUid', async () => {
    const app = buildApp(new DriverService(activeDriverStore), { firebaseUid: 'attacker-uid', role: 'driver', driverId: 'driver-1' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the driver is suspended', async () => {
    const suspendedStore = createFakeStore({
      'driver-1': {
        driverId: 'driver-1',
        firebaseUid: 'uid-1',
        name: 'X',
        status: 'suspended',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const app = buildApp(new DriverService(suspendedStore), { firebaseUid: 'uid-1', role: 'driver', driverId: 'driver-1' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects (403, not a crash) when the driver lookup throws', async () => {
    const throwingService = new DriverService({
      get: async () => {
        throw new Error('simulated Firestore failure');
      },
      set: async () => {},
      findByFirebaseUid: async () => null,
      listByStatus: async () => [],
    });
    const app = buildApp(throwingService, { firebaseUid: 'uid-1', role: 'driver', driverId: 'driver-1' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });
});
