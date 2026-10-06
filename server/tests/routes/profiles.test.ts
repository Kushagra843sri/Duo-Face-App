import { randomBytes } from 'crypto';

import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { ProfileStore } from '../../src/integrations/firebase/FirestoreProfileStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { ObjectHead, ObjectStorage } from '../../src/integrations/storage/R2Storage';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverProfileRouter } from '../../src/routes/driver/profile';
import { createMerchantProfileRouter } from '../../src/routes/merchant/profile';
import { DriverProfileService } from '../../src/services/driverProfileService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { FieldCrypto } from '../../src/services/fieldCrypto';
import { MerchantProfileService } from '../../src/services/merchantProfileService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import { verhoeffCheckDigit } from '../../src/validators/indianIds';
import { RecordingEvents } from '../helpers/recordingEvents';

const T = new Date('2026-06-01T10:00:00Z');
const auth = { Authorization: 'Bearer token' };
const AADHAAR = `23456789012${verhoeffCheckDigit('23456789012')}`;
const PAN = 'ABCDE1234F';
const LICENCE = 'DL0420110012345';
const ACCOUNT = '123456789012';

function memoryProfileStore(): ProfileStore & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  return { data, get: async (id) => data.get(id) ?? null, set: async (id, v) => void data.set(id, JSON.parse(JSON.stringify(v, (_k, val) => val)) as Record<string, unknown>) };
}

/** In-memory bucket. `uploaded` simulates what the phone PUT; `deleted` records cleanup. */
function fakeStorage(enabled = true) {
  const objects = new Map<string, ObjectHead>();
  const deleted: string[] = [];
  const storage: ObjectStorage = {
    enabled,
    presignPut: ({ key, contentType, contentLength }) => `https://signed.example/put/${key}?ct=${encodeURIComponent(contentType)}&len=${contentLength}&sig=SECRET`,
    presignGet: (key) => `https://signed.example/get/${key}?sig=SECRET`,
    head: async (key) => objects.get(key) ?? null,
    delete: async (key) => void (objects.delete(key), deleted.push(key)),
  };
  return { storage, objects, deleted };
}

const identityDoc = (role: 'driver' | 'merchant') =>
  role === 'driver'
    ? { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: T, updatedAt: T }
    : { firebaseUid: 'uid-1', role: 'merchant', status: 'active', merchant: { shopId: 'shop-1' }, createdAt: T, updatedAt: T };

function build(opts: { role?: 'driver' | 'merchant'; crypto?: boolean; storageEnabled?: boolean; commissionBps?: number | null } = {}) {
  const role = opts.role ?? 'driver';
  const driverDocs = new Map<string, Record<string, unknown>>([
    ['driver-1', { driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Old Name', phoneNumber: '+919000000000', status: 'active', createdAt: T, updatedAt: T }],
    ['driver-2', { driverId: 'driver-2', firebaseUid: 'uid-2', name: 'Other Driver', status: 'active', createdAt: T, updatedAt: T }],
  ]);
  const driverStore: DuoFaceDriverStore = {
    get: async (id) => driverDocs.get(id) ?? null,
    set: async (id, v) => void driverDocs.set(id, v),
    listByStatus: async () => [...driverDocs.values()],
    findByFirebaseUid: async (uid) => [...driverDocs.values()].find((d) => d.firebaseUid === uid) ?? null,
  };
  const shopDocs = new Map<string, Record<string, unknown>>([
    ['shop-1', { shopId: 'shop-1', name: 'Old Shop', status: 'active', merchantFirebaseUid: 'uid-1', customerAppShopId: 'cust-1', createdAt: T, updatedAt: T }],
  ]);
  const shopStore: DuoFaceShopStore = {
    get: async (id) => shopDocs.get(id) ?? null,
    set: async (id, v) => void shopDocs.set(id, v),
    findByMerchantFirebaseUid: async (uid) => [...shopDocs.values()].find((s) => s.merchantFirebaseUid === uid) ?? null,
    findByCustomerAppShopId: async (c) => [...shopDocs.values()].find((s) => s.customerAppShopId === c) ?? null,
  };
  const identity: DuoFaceIdentityStore = { get: async () => identityDoc(role), set: async () => {} };
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: 'uid-1' }) };
  const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identity));

  const driverService = new DriverService(driverStore);
  const shopService = new DuoFaceShopService(shopStore);
  const crypto = opts.crypto === false ? null : new FieldCrypto(randomBytes(32));
  const bucket = fakeStorage(opts.storageEnabled ?? true);
  const commission = opts.commissionBps === undefined ? 1000 : opts.commissionBps;

  const driverProfiles = memoryProfileStore();
  const merchantProfiles = memoryProfileStore();
  const events = new RecordingEvents();
  const driverService_ = new DriverProfileService(driverProfiles, driverService, crypto, bucket.storage, commission, () => T, events);
  const merchantService_ = new MerchantProfileService(merchantProfiles, shopService, crypto, bucket.storage, commission, () => T, events);

  const app = express();
  app.use(express.json());
  app.use('/driver/profile', createDriverProfileRouter(verifier, resolver, driverService, driverService_));
  app.use('/merchant/profile', createMerchantProfileRouter(verifier, resolver, shopService, merchantService_));
  app.use(errorHandler);
  return { app, driverProfiles, merchantProfiles, driverDocs, shopDocs, driverService_, merchantService_, events, ...bucket };
}

const personal = {
  fullName: 'Ravi Kumar',
  contactPhone: '+919811100001',
  dateOfBirth: '1995-04-12',
  address: { line1: '12 MG Road', city: 'Delhi', pincode: '110001' },
  emergencyContact: { name: 'Sita Kumar', phone: '+919811100002' },
};
const identity = { aadhaarNumber: AADHAAR, panNumber: PAN, licenceNumber: LICENCE, licenceExpiry: '2099-01-01' };
const vehicle = { type: 'motorcycle', registrationNumber: 'DL1AB1234', makeModel: 'Honda Shine' };
const bank = { accountHolderName: 'Ravi Kumar', accountNumber: ACCOUNT, ifsc: 'SBIN0001234', bankName: 'SBI', upiId: 'ravi@oksbi' };
const patchDriver = (app: express.Express, body: unknown) => request(app).patch('/driver/profile').set(auth).send(body as object);
const patchMerchant = (app: express.Express, body: unknown) => request(app).patch('/merchant/profile').set(auth).send(body as object);

async function uploadPhoto(t: ReturnType<typeof build>, base: string, kind: string, size = 2000, type = 'image/jpeg') {
  const grant = await request(t.app).post(`${base}/photo-upload`).set(auth).send({ kind, contentType: type, sizeBytes: size });
  expect(grant.status).toBe(200);
  t.objects.set(grant.body.objectKey, { size, contentType: type }); // the phone PUT to the signed URL
  return grant.body.objectKey as string;
}

describe('driver profile: storage and masking', () => {
  it('saves every section and returns only masked values', async () => {
    const t = build();
    const res = await patchDriver(t.app, { personal, identity, vehicle, bank });
    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({ aadhaarMasked: `XXXX-XXXX-${AADHAAR.slice(-4)}`, panMasked: '••••••234F', licenceMasked: '•••••••••••2345', licenceExpiry: '2099-01-01' });
    expect(res.body.bank).toMatchObject({ accountMasked: '••••9012', ifsc: 'SBIN0001234', upiId: 'ravi@oksbi' });
    const text = JSON.stringify(res.body);
    for (const secret of [AADHAAR, PAN, LICENCE, ACCOUNT]) expect(text).not.toContain(secret);
  });

  it('never writes the full Aadhaar, PAN, licence or account number to storage; only ciphertext and last digits', async () => {
    const t = build();
    await patchDriver(t.app, { personal, identity, vehicle, bank });
    const stored = JSON.stringify(t.driverProfiles.data.get('driver-1'));
    for (const secret of [AADHAAR, PAN, LICENCE, ACCOUNT]) expect(stored).not.toContain(secret);
    expect(stored).toContain('panEnc');
    expect(stored).toContain(AADHAAR.slice(-4));
    // The ciphertext is real: the server can read it back, bound to this driver and field.
    const doc = t.driverProfiles.data.get('driver-1') as never;
    expect(t.driverService_.readSensitive(doc, 'driver-1', 'pan')).toBe(PAN);
    expect(t.driverService_.readSensitive(doc, 'driver-1', 'bank-account')).toBe(ACCOUNT);
    expect(() => t.driverService_.readSensitive(doc, 'driver-2', 'pan')).toThrow();
  });

  it('syncs the display name and phone onto the main driver document (used by merchants and masked calls)', async () => {
    const t = build();
    await patchDriver(t.app, { personal });
    expect(t.driverDocs.get('driver-1')).toMatchObject({ name: 'Ravi Kumar', phoneNumber: '+919811100001', status: 'active' });
    expect(t.driverDocs.get('driver-2')).toMatchObject({ name: 'Other Driver' });
  });

  it('keeps the stored account number when the bank section is saved without re-entering it', async () => {
    const t = build();
    await patchDriver(t.app, { bank });
    const { accountNumber: _omit, ...withoutAccount } = bank;
    void _omit;
    const res = await patchDriver(t.app, { bank: { ...withoutAccount, bankName: 'State Bank of India' } });
    expect(res.status).toBe(200);
    expect(res.body.bank).toMatchObject({ accountMasked: '••••9012', bankName: 'State Bank of India' });
  });

  it('rejects invalid details with a specific message (400) and stores nothing', async () => {
    const t = build();
    const cases: Array<[unknown, RegExp]> = [
      [{ identity: { aadhaarNumber: '123456789012' } }, /Aadhaar/],
      [{ identity: { panNumber: 'BADPAN' } }, /PAN/],
      [{ bank: { ...bank, ifsc: 'NOPE' } }, /IFSC/],
      [{ bank: { ...bank, accountNumber: '12' } }, /9-18 digits/],
      [{ vehicle: { ...vehicle, registrationNumber: 'X' } }, /vehicle number/],
      [{ personal: { ...personal, dateOfBirth: '2015-01-01' } }, /18/],
      [{ personal: { ...personal, contactPhone: '9811100001' } }, /country code/],
      [{ identity: { licenceExpiry: '2001-01-01' } }, /future/],
    ];
    for (const [body, message] of cases) {
      const res = await patchDriver(t.app, body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    expect(t.driverProfiles.data.size).toBe(0);
  });

  it.each([
    [{ personal, commissionBps: 0 }],
    [{ personal, kycStatus: 'verified' }],
    [{ bank, bankStatus: 'verified' }],
    [{ personal, driverId: 'driver-2' }],
    [{ personal, payoutReady: true }],
    [{}],
  ])('rejects %j (server-owned or unknown field / empty) with 400', async (body) => {
    const t = build();
    expect((await patchDriver(t.app, body)).status).toBe(400);
    expect(t.driverProfiles.data.size).toBe(0);
  });

  it('answers 503 for PAN / licence / bank account when secure storage is not configured, but never stores plaintext', async () => {
    const t = build({ crypto: false });
    expect((await patchDriver(t.app, { identity: { panNumber: PAN } })).status).toBe(503);
    expect((await patchDriver(t.app, { bank })).status).toBe(503);
    expect(JSON.stringify([...t.driverProfiles.data.values()])).not.toContain(PAN);
    // Sections that need no encryption still work (Aadhaar keeps only the last 4).
    expect((await patchDriver(t.app, { personal })).status).toBe(200);
    expect((await patchDriver(t.app, { identity: { aadhaarNumber: AADHAAR } })).status).toBe(200);
  });
});

describe('driver profile: review status, payouts, commission', () => {
  it('stays incomplete until the live photos exist, then goes to review; bank goes to review when complete', async () => {
    const t = build();
    const first = await patchDriver(t.app, { personal, identity, vehicle, bank });
    expect(first.body.kycStatus).toBe('incomplete'); // photos still missing
    expect(first.body.bankStatus).toBe('pending_review');
    expect(first.body.completeness).toMatchObject({ completed: 4, total: 5 });

    await uploadPhoto(t, '/driver/profile', 'selfie').then((key) => request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: key }));
    const key = await uploadPhoto(t, '/driver/profile', 'vehicle');
    expect((await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'vehicle', objectKey: key })).status).toBe(204);

    const res = await request(t.app).get('/driver/profile').set(auth);
    expect(res.body.kycStatus).toBe('pending_review');
    expect(res.body.completeness).toMatchObject({ completed: 5, total: 5 });
    expect(res.body.payoutReady).toBe(false); // nothing is verified without an admin
  });

  it('is payout-ready only when BOTH KYC and bank are verified; editing verified data sends it back to review', async () => {
    const t = build();
    await patchDriver(t.app, { personal, identity, vehicle, bank });
    for (const kind of ['selfie', 'vehicle']) {
      const key = await uploadPhoto(t, '/driver/profile', kind);
      await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind, objectKey: key });
    }
    await t.driverService_.setVerification('driver-1', { kycStatus: 'verified', bankStatus: 'verified' });
    expect((await request(t.app).get('/driver/profile').set(auth)).body.payoutReady).toBe(true);

    // Changing the bank account re-opens bank review only; payouts pause until re-verified.
    const changed = await patchDriver(t.app, { bank: { ...bank, accountNumber: '999988887777' } });
    expect(changed.body).toMatchObject({ kycStatus: 'verified', bankStatus: 'pending_review', payoutReady: false });

    // Changing identity re-opens KYC.
    await t.driverService_.setVerification('driver-1', { bankStatus: 'verified' });
    const identityChange = await patchDriver(t.app, { identity: { panNumber: 'ZZZZZ9999Z' } });
    expect(identityChange.body).toMatchObject({ kycStatus: 'pending_review', bankStatus: 'verified', payoutReady: false });
  });

  it('records the platform commission once (read-only for the client)', async () => {
    const t = build({ commissionBps: 1500 });
    expect((await patchDriver(t.app, { personal })).body.commissionBps).toBe(1500);
    const none = build({ commissionBps: null });
    expect((await patchDriver(none.app, { personal })).body.commissionBps).toBeNull(); // nothing is assumed when unconfigured
  });
});

describe('driver profile: photos', () => {
  it('issues a signed upload for a server-chosen key under the driver, bound to type and size', async () => {
    const t = build();
    const res = await request(t.app).post('/driver/profile/photo-upload').set(auth).send({ kind: 'vehicle', contentType: 'image/jpeg', sizeBytes: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.objectKey).toMatch(/^driver\/driver-1\/vehicle\/[0-9a-f-]{36}\.jpg$/);
    expect(res.body.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': '1234' });
    expect(res.body.expiresInSeconds).toBe(300);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each([
    [{ kind: 'selfie', contentType: 'application/pdf', sizeBytes: 100 }],
    [{ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 6 * 1024 * 1024 }],
    [{ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 0 }],
    [{ kind: 'passport', contentType: 'image/jpeg', sizeBytes: 100 }],
    [{ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 100, objectKey: 'driver/driver-2/selfie/x.jpg' }],
  ])('refuses the upload request %j (400)', async (body) => {
    const t = build();
    expect((await request(t.app).post('/driver/profile/photo-upload').set(auth).send(body)).status).toBe(400);
  });

  it("will not attach another driver's object, another kind's object, or a path trick", async () => {
    const t = build();
    for (const objectKey of ['driver/driver-2/selfie/x.jpg', 'driver/driver-1/vehicle/x.jpg', 'merchant/shop-1/shop/x.jpg', 'driver/driver-1/selfie/../../driver-2/selfie/x.jpg']) {
      t.objects.set(objectKey, { size: 100, contentType: 'image/jpeg' });
      expect((await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey })).status).toBe(400);
    }
  });

  it('confirm fails if nothing was uploaded, and deletes an oversized or wrong-type object', async () => {
    const t = build();
    expect((await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: 'driver/driver-1/selfie/missing.jpg' })).status).toBe(409);

    const big = 'driver/driver-1/selfie/big.jpg';
    t.objects.set(big, { size: 9 * 1024 * 1024, contentType: 'image/jpeg' });
    expect((await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: big })).status).toBe(409);
    const exe = 'driver/driver-1/selfie/x.jpg';
    t.objects.set(exe, { size: 100, contentType: 'application/x-msdownload' });
    expect((await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: exe })).status).toBe(409);
    expect(t.deleted).toEqual(expect.arrayContaining([big, exe]));
  });

  it('stores only the KEY; the profile returns short-lived signed view URLs; replacing a photo deletes the old object', async () => {
    const t = build();
    const first = await uploadPhoto(t, '/driver/profile', 'selfie');
    await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: first });
    const stored = JSON.stringify(t.driverProfiles.data.get('driver-1'));
    expect(stored).toContain(first);
    expect(stored).not.toContain('signed.example');
    expect((await request(t.app).get('/driver/profile').set(auth)).body.photos.selfieUrl).toBe(`https://signed.example/get/${first}?sig=SECRET`);

    const second = await uploadPhoto(t, '/driver/profile', 'selfie');
    await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: second });
    expect(t.deleted).toContain(first);

    expect((await request(t.app).delete('/driver/profile/photo/selfie').set(auth)).status).toBe(204);
    expect(t.deleted).toContain(second);
    expect((await request(t.app).get('/driver/profile').set(auth)).body.photos.selfieUrl).toBeNull();
  });

  it('never logs a signed URL or object key', async () => {
    const t = build();
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const key = await uploadPhoto(t, '/driver/profile', 'selfie');
    await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: key });
    await request(t.app).get('/driver/profile').set(auth);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain('signed.example');
    expect(logged).not.toContain(key);
  });

  it('answers 503 when photo storage is not configured, while the rest of the profile works', async () => {
    const t = build({ storageEnabled: false });
    expect((await request(t.app).post('/driver/profile/photo-upload').set(auth).send({ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 100 })).status).toBe(503);
    expect((await patchDriver(t.app, { personal })).status).toBe(200);
  });
});

describe('merchant profile', () => {
  const merchantPersonal = { shopName: 'Fresh Mart', ownerName: 'Anil Sharma', contactPhone: '+919822200001', email: 'anil@example.com', address: { line1: '5 Market Road', city: 'Delhi', pincode: '110016' } };

  it('saves shop, tax, bank and pickup location; masks PAN/account; syncs name and pickup onto the shop', async () => {
    const t = build({ role: 'merchant' });
    const res = await patchMerchant(t.app, {
      personal: merchantPersonal,
      identity: { panNumber: PAN, gstin: '27AAPFU0939F1ZV', fssai: '98765432109876' },
      bank,
      pickupLocation: { latitude: 28.5583, longitude: 77.2028 },
    });
    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({ panMasked: '••••••234F', gstin: '27AAPFU0939F1ZV', fssai: '98765432109876' });
    expect(res.body.bank.accountMasked).toBe('••••9012');
    expect(res.body.pickupLocation).toEqual({ latitude: 28.5583, longitude: 77.2028 });
    expect(JSON.stringify(res.body)).not.toContain(PAN);
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT);
    expect(JSON.stringify(t.merchantProfiles.data.get('shop-1'))).not.toContain(PAN);
    expect(JSON.stringify(t.merchantProfiles.data.get('shop-1'))).not.toContain(ACCOUNT);
    expect(t.shopDocs.get('shop-1')).toMatchObject({ name: 'Fresh Mart', status: 'active', pickupLocation: { latitude: 28.5583, longitude: 77.2028 } });
    expect(res.body.completeness).toMatchObject({ completed: 4, total: 4 }); // photo is optional
    expect(res.body.kycStatus).toBe('pending_review');
  });

  it('the photo is optional: no photo means photoUrl null and nothing blocks review', async () => {
    const t = build({ role: 'merchant' });
    const res = await patchMerchant(t.app, { personal: merchantPersonal, identity: { panNumber: PAN } });
    expect(res.body.photoUrl).toBeNull();
    expect(res.body.kycStatus).toBe('pending_review');
  });

  it('uploads, shows and removes the optional photo under the shop prefix', async () => {
    const t = build({ role: 'merchant' });
    const key = await uploadPhoto(t, '/merchant/profile', 'shop');
    expect(key).toMatch(/^merchant\/shop-1\/shop\//);
    expect((await request(t.app).post('/merchant/profile/photo-confirm').set(auth).send({ kind: 'shop', objectKey: key })).status).toBe(204);
    expect((await request(t.app).get('/merchant/profile').set(auth)).body.photoUrl).toContain(key);
    expect((await request(t.app).delete('/merchant/profile/photo/shop').set(auth)).status).toBe(204);
    expect((await request(t.app).get('/merchant/profile').set(auth)).body.photoUrl).toBeNull();
  });

  it.each([
    [{ personal: merchantPersonal, shopId: 'shop-9' }],
    [{ personal: merchantPersonal, commissionBps: 0 }],
    [{ personal: merchantPersonal, kycStatus: 'verified' }],
    [{ identity: { gstin: 'BAD' } }],
    [{ pickupLocation: { latitude: 120, longitude: 0 } }],
    [{}],
  ])('rejects %j with 400', async (body) => {
    const t = build({ role: 'merchant' });
    expect((await patchMerchant(t.app, body)).status).toBe(400);
  });

  it('503 for PAN / bank without secure storage', async () => {
    const t = build({ role: 'merchant', crypto: false });
    expect((await patchMerchant(t.app, { identity: { panNumber: PAN } })).status).toBe(503);
    expect(JSON.stringify([...t.merchantProfiles.data.values()])).not.toContain(PAN);
  });
});

describe('profile access control', () => {
  it('a merchant cannot use the driver profile routes, and a driver cannot use the merchant ones', async () => {
    const asMerchant = build({ role: 'merchant' });
    expect((await request(asMerchant.app).get('/driver/profile').set(auth)).status).toBe(403);
    expect((await patchDriver(asMerchant.app, { personal })).status).toBe(403);
    const asDriver = build({ role: 'driver' });
    expect((await request(asDriver.app).get('/merchant/profile').set(auth)).status).toBe(403);
    expect((await patchMerchant(asDriver.app, { identity: { panNumber: PAN } })).status).toBe(403);
  });

  it('requires authentication', async () => {
    const t = build();
    expect((await request(t.app).get('/driver/profile')).status).toBe(401);
    expect((await request(t.app).patch('/driver/profile').send({ personal })).status).toBe(401);
  });

  it("a driver's profile is only ever their own: no id parameter exists", async () => {
    const t = build();
    await patchDriver(t.app, { personal });
    expect((await request(t.app).get('/driver/profile/driver-2').set(auth)).status).toBe(404);
    expect((await request(t.app).get('/driver/profile?driverId=driver-2').set(auth)).body.personal.fullName).toBe('Ravi Kumar');
    expect(t.driverProfiles.data.has('driver-2')).toBe(false);
  });
});

describe('admins are told when something enters review', () => {
  it('a driver: bank details complete -> one alert; photos complete the KYC -> a second; edits while waiting -> none', async () => {
    const t = build();
    await patchDriver(t.app, { personal, identity, vehicle, bank });
    expect(t.events.calls).toHaveLength(1); // bank newly pending
    expect(t.events.calls[0]).toMatch(/^kycSubmitted:driver:driver-1:\d+$/);

    await patchDriver(t.app, { personal: { ...personal, fullName: 'Ravi K Sharma' } }); // already waiting / still incomplete
    expect(t.events.calls).toHaveLength(1);

    const selfie = await uploadPhoto(t, '/driver/profile', 'selfie');
    await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'selfie', objectKey: selfie });
    expect(t.events.calls).toHaveLength(1); // KYC still incomplete (vehicle photo missing)
    const vehiclePhoto = await uploadPhoto(t, '/driver/profile', 'vehicle');
    await request(t.app).post('/driver/profile/photo-confirm').set(auth).send({ kind: 'vehicle', objectKey: vehiclePhoto });
    expect(t.events.calls).toHaveLength(2); // KYC newly pending
  });

  it('a verified section that is edited goes back to review and the admins are told again', async () => {
    const t = build();
    await patchDriver(t.app, { personal, identity, vehicle, bank });
    t.events.calls = [];
    await t.driverService_.setVerification('driver-1', { bankStatus: 'verified' });
    await patchDriver(t.app, { bank: { ...bank, bankName: 'Another Bank' } });
    expect(t.events.calls).toHaveLength(1);
    expect(t.events.calls[0]).toMatch(/^kycSubmitted:driver:driver-1:/);
  });

  it('a shop: a complete profile -> one alert; an edit while waiting -> none', async () => {
    const t = build({ role: 'merchant' });
    const shopPersonal = { shopName: 'Fresh Mart', ownerName: 'Anil Sharma', contactPhone: '+919822200001', email: 'anil@example.com', address: { line1: '5 Market Road', city: 'Delhi', pincode: '110016' } };
    await patchMerchant(t.app, { personal: shopPersonal, identity: { panNumber: PAN } });
    expect(t.events.calls.filter((c) => c.startsWith('kycSubmitted:merchant:'))).toHaveLength(1);
    t.events.calls = [];
    await patchMerchant(t.app, { personal: { ...shopPersonal, ownerName: 'Someone Else' } });
    expect(t.events.calls).toEqual([]);
  });
});
