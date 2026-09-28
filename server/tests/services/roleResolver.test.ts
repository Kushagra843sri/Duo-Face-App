import { DuoFaceRoleResolver, UnresolvedRoleResolver } from '../../src/services/roleResolver';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';

// UnresolvedRoleResolver touches no Firestore at all — it's an explicit
// test double / fallback now, not the production default (see
// DuoFaceRoleResolver below). That means scenarios like "malformed
// Firestore data" or "Firestore failure" don't apply to it: there's no
// Firestore call to fail or return malformed data from.
describe('UnresolvedRoleResolver', () => {
  it('always resolves to null, regardless of the Firebase UID', async () => {
    const resolver = new UnresolvedRoleResolver();

    await expect(resolver.resolve('known-looking-uid')).resolves.toBeNull();
    await expect(resolver.resolve('totally-unknown-uid')).resolves.toBeNull();
    await expect(resolver.resolve('')).resolves.toBeNull();
  });
});

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

describe('DuoFaceRoleResolver', () => {
  it('resolves a merchant principal for an active merchant identity', async () => {
    const store = createFakeStore({
      uid: {
        firebaseUid: 'uid',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    await expect(resolver.resolve('uid')).resolves.toEqual({ firebaseUid: 'uid', role: 'merchant', shopId: 'shop-1' });
  });

  it('resolves a driver principal for an active driver identity', async () => {
    const store = createFakeStore({
      uid: {
        firebaseUid: 'uid',
        role: 'driver',
        status: 'active',
        driver: { driverId: 'driver-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    await expect(resolver.resolve('uid')).resolves.toEqual({ firebaseUid: 'uid', role: 'driver', driverId: 'driver-1' });
  });

  it('resolves null for an unmapped Firebase UID', async () => {
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(createFakeStore()));
    await expect(resolver.resolve('unknown-uid')).resolves.toBeNull();
  });

  it('resolves null (not a principal) for a suspended identity', async () => {
    const store = createFakeStore({
      uid: {
        firebaseUid: 'uid',
        role: 'merchant',
        status: 'suspended',
        merchant: { shopId: 'shop-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    await expect(resolver.resolve('uid')).resolves.toBeNull();
  });

  it('resolves null (not an error) when the stored identity is malformed', async () => {
    const store = createFakeStore({
      // Active merchant with no shopId — duoFaceIdentitySchema rejects this,
      // DuoFaceIdentityService throws, and the resolver must catch it rather
      // than let it propagate or guess a role.
      uid: { firebaseUid: 'uid', role: 'merchant', status: 'active', createdAt: new Date(), updatedAt: new Date() },
    });
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(store));

    await expect(resolver.resolve('uid')).resolves.toBeNull();
  });
});
