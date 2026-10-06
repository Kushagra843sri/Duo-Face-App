import './helpers/env';

import { installRuntime } from '../../src/runtime';
import { resetDb, UIDS } from './helpers/harness';
import { api, inboxTypes, settle } from './helpers/scenario';

jest.mock('firebase-admin/firestore', () => require('./helpers/firestoreMock'));
jest.mock('firebase-admin/app', () => ({ initializeApp: () => ({}), cert: () => ({}), applicationDefault: () => ({}), getApps: () => [] }));
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: async (token: string) => {
      if (!token.startsWith('tok-')) throw new Error('invalid token');
      return { uid: token.slice(4) };
    },
  }),
}));

/** KYC review across the shop app and the admin app: submit, review, decide, resubmit. */
const M = 'uid-kyc-merchant';
const personal = { shopName: 'Fresh Mart', ownerName: 'Anil Sharma', contactPhone: '+919822200001', address: { line1: '5 Market Road', city: 'Delhi', pincode: '110016' } };
const PAN = 'ABCDE1234F';
let shopId = '';
let version = '';

beforeAll(async () => {
  installRuntime();
  resetDb();
  expect((await api.post(M, '/auth/register', { intent: 'merchant', shopName: 'Fresh Mart' })).status).toBe(201);
  shopId = (await api.get(M, '/merchant/me')).body.shopId;
});

describe('a shop owner submits their details and an admin reviews them', () => {
  it('saving complete KYC details puts them in review and alerts the admin', async () => {
    const saved = await api.patch(M, '/merchant/profile', { personal, identity: { panNumber: PAN } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ kycStatus: 'pending_review', kycReviewNote: null });
    await settle(async () => (await inboxTypes(UIDS.admin)).includes('admin_kyc_submitted'), 'admin told about the submission');
  });

  it('the admin finds it in the queue and sees masked details only', async () => {
    const queue = await api.get(UIDS.admin, '/admin/verifications');
    expect(queue.body.items).toMatchObject([{ kind: 'merchant', ownerId: shopId, name: 'Fresh Mart', pending: ['kyc'] }]);
    const detail = await api.get(UIDS.admin, `/admin/verifications/merchant/${shopId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.verification.profile.identity.panMasked).toBe('••••••234F');
    expect(JSON.stringify(detail.body)).not.toContain(PAN);
    version = detail.body.verification.version;
  });

  it('rejecting needs a reason; with one, the owner sees why and is notified', async () => {
    expect((await api.post(UIDS.admin, `/admin/verifications/merchant/${shopId}/kyc`, { decision: 'reject', version })).status).toBe(400);
    const rejected = await api.post(UIDS.admin, `/admin/verifications/merchant/${shopId}/kyc`, { decision: 'reject', reason: 'The PAN does not match the owner name', version });
    expect(rejected.status).toBe(200);

    const profile = await api.get(M, '/merchant/profile');
    expect(profile.body).toMatchObject({ kycStatus: 'rejected', kycReviewNote: 'The PAN does not match the owner name' });
    await settle(async () => (await inboxTypes(M)).includes('kyc_rejected'), 'owner told it was rejected');
    expect((await api.get(UIDS.admin, '/admin/verifications')).body.items).toEqual([]);
  });

  it('the owner fixes and resubmits: back in the queue, the old reason is gone, and the admin is alerted again', async () => {
    const fixed = await api.patch(M, '/merchant/profile', { personal: { ...personal, ownerName: 'Anil K Sharma' }, identity: { panNumber: PAN } });
    expect(fixed.body).toMatchObject({ kycStatus: 'pending_review', kycReviewNote: null });
    expect((await api.get(UIDS.admin, '/admin/verifications')).body.items).toHaveLength(1);
    await settle(async () => ((await api.get(UIDS.admin, '/notifications')).body.notifications as { type: string }[]).filter((n) => n.type === 'admin_kyc_submitted').length === 2, 'second submission alert');
  });

  it('a decision made on details the owner has since changed is refused (nothing is approved blindly)', async () => {
    const opened = (await api.get(UIDS.admin, `/admin/verifications/merchant/${shopId}`)).body.verification.version as string;
    await api.patch(M, '/merchant/profile', { personal: { ...personal, ownerName: 'Someone Else Entirely' } }); // changes after the admin opened it
    const stale = await api.post(UIDS.admin, `/admin/verifications/merchant/${shopId}/kyc`, { decision: 'approve', version: opened });
    expect(stale.status).toBe(409);
    expect((await api.get(M, '/merchant/profile')).body.kycStatus).toBe('pending_review');
  });

  it('approving the latest version verifies it, tells the owner, and empties the queue', async () => {
    const latest = (await api.get(UIDS.admin, `/admin/verifications/merchant/${shopId}`)).body.verification.version as string;
    expect((await api.post(UIDS.admin, `/admin/verifications/merchant/${shopId}/kyc`, { decision: 'approve', version: latest })).status).toBe(200);
    expect((await api.get(M, '/merchant/profile')).body.kycStatus).toBe('verified');
    await settle(async () => (await inboxTypes(M)).includes('kyc_approved'), 'owner told it was approved');
    expect((await api.get(UIDS.admin, '/admin/verifications')).body.items).toEqual([]);
    // Approval is status only: the shop can still be opened and sold from either way.
    expect((await api.put(M, '/merchant/shop/open', { isOpen: true })).status).toBe(200);
  });

  it('nobody but an admin can read the queue or decide', async () => {
    for (const uid of [M, UIDS.customer, UIDS.driver]) {
      expect((await api.get(uid, '/admin/verifications')).status).toBe(403);
      expect((await api.post(uid, `/admin/verifications/merchant/${shopId}/kyc`, { decision: 'approve', version })).status).toBe(403);
    }
  });
});
