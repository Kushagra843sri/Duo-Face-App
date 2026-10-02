import { FirestoreCustomerAppOrderProvider } from '../../src/integrations/customerApp/FirestoreCustomerAppOrderProvider';

describe('FirestoreCustomerAppOrderProvider', () => {
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

  it('listOrdersByShopId fails clearly (not silently) when Firebase is unconfigured', async () => {
    const provider = new FirestoreCustomerAppOrderProvider();
    await expect(provider.listOrdersByShopId('shop-1')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('getOrderById fails clearly when Firebase is unconfigured', async () => {
    const provider = new FirestoreCustomerAppOrderProvider();
    await expect(provider.getOrderById('order-1')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });

  it('exposes no generic status writer: the only write is markOrderDelivered', () => {
    const provider = new FirestoreCustomerAppOrderProvider() as unknown as Record<string, unknown>;
    expect(provider.updateOrderStatus).toBeUndefined();
    expect(typeof provider.markOrderDelivered).toBe('function');
  });

  it('markOrderDelivered fails as a categorized error (no Firestore internals) when Firebase is unconfigured', async () => {
    const provider = new FirestoreCustomerAppOrderProvider();
    const error = await provider.markOrderDelivered('order-1', 'shop-1').catch((e: Error) => e);
    expect((error as Error).name).toBe('CustomerAppUnavailableError');
    expect((error as Error).message).not.toMatch(/FIREBASE_PROJECT_ID|orders/);
  });
});
