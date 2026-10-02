import { FirestoreCustomerAppInventoryProvider } from '../../src/integrations/customerApp/FirestoreCustomerAppInventoryProvider';

// This class touches real firebase-admin/firestore only when getProduct()
// is actually called against a configured Firebase project — which these
// tests don't exercise. Instead, we verify the two unimplemented methods
// fail clearly rather than silently, matching Phase 1.75's decision that
// the Customer App has no stock quantity concept to read or adjust.
describe('FirestoreCustomerAppInventoryProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('getProduct fails clearly (not silently) when Firebase is unconfigured', async () => {
    const provider = new FirestoreCustomerAppInventoryProvider();
    await expect(provider.getProduct('any-product')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('getStock throws — no such concept exists in the Customer App', async () => {
    const provider = new FirestoreCustomerAppInventoryProvider();
    await expect(provider.getStock('any-product')).rejects.toThrow(/no stock quantity concept/i);
  });

  it('adjustStock throws — no such concept exists in the Customer App', async () => {
    const provider = new FirestoreCustomerAppInventoryProvider();
    await expect(provider.adjustStock('any-product', 1)).rejects.toThrow(/no stock quantity concept/i);
  });
});
