/**
 * Exercises the REAL FirestoreCustomerAppOrderProvider.markOrderDelivered
 * transaction logic against a mocked Firestore (jest.mock). It verifies the
 * decision branches and that exactly `{ status: 'delivered' }` is written —
 * it does NOT prove Firestore's real transactional behavior.
 */
const updateMock = jest.fn();
let docData: Record<string, unknown> | undefined;
let runTransactionImpl: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;

jest.mock('../../src/integrations/firebase/firebaseAdmin', () => ({ getFirebaseAdminApp: () => ({}) }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => ({ doc: (id: string) => ({ __path: `${name}/${id}` }) }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => runTransactionImpl(fn),
  }),
}));

import { CustomerAppUnavailableError } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreCustomerAppOrderProvider } from '../../src/integrations/customerApp/FirestoreCustomerAppOrderProvider';

beforeEach(() => {
  updateMock.mockReset();
  docData = undefined;
  runTransactionImpl = (fn) =>
    fn({
      get: async () => ({ exists: docData !== undefined, data: () => docData }),
      update: updateMock,
    });
});

const provider = new FirestoreCustomerAppOrderProvider();

describe('FirestoreCustomerAppOrderProvider.markOrderDelivered', () => {
  it('out_for_delivery -> writes exactly { status: "delivered" } and nothing else', async () => {
    docData = { shopId: 'shop-1', status: 'out_for_delivery', paymentId: 'pay_1', customerId: 'c', pricing: { total: 1 } };
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'completed' });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1]).toEqual({ status: 'delivered' });
  });

  it('already delivered -> no write', async () => {
    docData = { shopId: 'shop-1', status: 'delivered' };
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'already_delivered' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'rejected', 'pending', 'confirmed', 'preparing', 'ready_for_pickup'])('%s -> protected, no write', async (status) => {
    docData = { shopId: 'shop-1', status };
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'protected_status', status });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a missing status is protected as "unknown"', async () => {
    docData = { shopId: 'shop-1' };
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'protected_status', status: 'unknown' });
  });

  it('missing order -> not_found; other shop -> shop_mismatch; neither writes', async () => {
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'not_found' });
    docData = { shopId: 'other', status: 'out_for_delivery' };
    expect(await provider.markOrderDelivered('order-1', 'shop-1')).toEqual({ kind: 'shop_mismatch' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each([
    [14, 'transient'],
    [4, 'transient'],
    [10, 'transient'],
    [undefined, 'transient'],
    [7, 'permanent'],
    [16, 'permanent'],
    ['permission-denied', 'permanent'],
  ])('maps Firestore error code %s to a %s category without leaking details', async (code, category) => {
    runTransactionImpl = async () => {
      throw Object.assign(new Error('7 PERMISSION_DENIED: projects/secret/databases/(default)/documents/orders/order-1'), { code });
    };
    const error = await provider.markOrderDelivered('order-1', 'shop-1').catch((e: Error) => e);
    expect(error).toBeInstanceOf(CustomerAppUnavailableError);
    expect((error as CustomerAppUnavailableError).category).toBe(category);
    expect((error as Error).message).not.toMatch(/secret|orders\/|PERMISSION/);
  });
});
