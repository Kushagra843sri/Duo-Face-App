import express from 'express';
import request from 'supertest';

import { createAuthRouter } from '../../src/routes/auth';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { AuthenticatedPrincipal } from '../../src/types/auth';

const okVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => ({ firebaseUid: 'test-uid' }),
};

const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};

const unresolvedResolver: RoleResolver = {
  resolve: async () => null,
};

const mockMerchantPrincipal: AuthenticatedPrincipal = {
  firebaseUid: 'test-uid',
  role: 'merchant',
  shopId: 'shop-1',
};

const resolvingResolver: RoleResolver = {
  resolve: async () => mockMerchantPrincipal,
};

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

function buildApp(verifier: FirebaseIdentityVerifier, roleResolver: RoleResolver) {
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(verifier, roleResolver));
  return app;
}

describe('GET /auth/me — authentication boundary', () => {
  it('returns 401 without an Authorization header', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver)).get('/auth/me');
    expect(response.status).toBe(401);
  });

  it('returns 401 for a malformed Authorization header', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver))
      .get('/auth/me')
      .set('Authorization', 'Basic sometoken');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const response = await request(buildApp(failingVerifier, unresolvedResolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });
});

describe('GET /auth/me — role resolution (ad-hoc resolver mocks)', () => {
  it('returns 403 for a valid identity with no mapped role', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('role_unresolved');
  });

  it('returns the resolved principal for a valid identity with a mapped role', async () => {
    const response = await request(buildApp(okVerifier, resolvingResolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockMerchantPrincipal);
  });

  it('ignores a role/shopId/driverId supplied in the request body', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token')
      .send({ role: 'merchant', shopId: 'attacker-shop', driverId: 'attacker-driver' });

    // Still 403: the (unresolved) resolver never sees the request body at all.
    expect(response.status).toBe(403);
  });

  it('ignores an X-Role header', async () => {
    const response = await request(buildApp(okVerifier, resolvingResolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token')
      .set('X-Role', 'driver');

    // Still resolves to whatever the resolver mock returns (merchant), not the header.
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockMerchantPrincipal);
  });
});

describe('GET /auth/me — real DuoFaceRoleResolver + DuoFaceIdentityService (fake Firestore store)', () => {
  it('returns 200 with shopId for an active merchant identity', async () => {
    const store = createFakeStore({
      'test-uid': {
        firebaseUid: 'test-uid',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    const response = await request(buildApp(okVerifier, resolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ firebaseUid: 'test-uid', role: 'merchant', shopId: 'shop-1' });
  });

  it('returns 200 with driverId for an active driver identity', async () => {
    const store = createFakeStore({
      'test-uid': {
        firebaseUid: 'test-uid',
        role: 'driver',
        status: 'active',
        driver: { driverId: 'driver-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    const response = await request(buildApp(okVerifier, resolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ firebaseUid: 'test-uid', role: 'driver', driverId: 'driver-1' });
  });

  it('returns 403 when no identity document exists', async () => {
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(createFakeStore()));

    const response = await request(buildApp(okVerifier, resolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });

  it('returns 403 for a suspended identity', async () => {
    const store = createFakeStore({
      'test-uid': {
        firebaseUid: 'test-uid',
        role: 'merchant',
        status: 'suspended',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    const response = await request(buildApp(okVerifier, resolver))
      .get('/auth/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });
});
