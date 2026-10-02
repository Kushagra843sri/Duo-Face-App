import { FirestoreCustomerAppProductProvider } from '../../src/integrations/customerApp/FirestoreCustomerAppProductProvider';

describe('FirestoreCustomerAppProductProvider', () => {
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

  it('fails clearly (not silently) when Firebase is unconfigured', async () => {
    const provider = new FirestoreCustomerAppProductProvider();
    await expect(provider.listProductsByShopId('shop-1')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });
});
