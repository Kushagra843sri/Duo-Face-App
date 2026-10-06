import type { ReviewableProfileStore } from '../../src/integrations/firebase/FirestoreProfileStore';
import { ProfileVerificationService } from '../../src/services/profileVerificationService';
import { reviewNote } from '../../src/types/profile';
import { RecordingEvents } from '../helpers/recordingEvents';

type Doc = Record<string, unknown>;

const T0 = new Date('2026-10-06T10:00:00Z');
const clock = { t: T0.getTime() };
const now = () => new Date(clock.t);
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

class MemoryReviewStore implements ReviewableProfileStore {
  data = new Map<string, Doc>();
  /** Lets a test change the stored profile in the middle of a decision (an applicant editing at the wrong moment). */
  beforeReplace: (() => void) | null = null;

  async get(id: string) {
    const d = this.data.get(id);
    return d ? structuredClone(d) : null;
  }
  async set(id: string, v: Doc) {
    this.data.set(id, structuredClone(v));
  }
  async listPending() {
    return [...this.data.entries()]
      .filter(([, d]) => d.kycStatus === 'pending_review' || d.bankStatus === 'pending_review')
      .map(([id, d]) => ({ ...structuredClone(d), _id: id }));
  }
  async replaceIfUnchanged(id: string, expectedMs: number, next: Doc) {
    this.beforeReplace?.();
    const current = this.data.get(id);
    if (!current || ms(current.updatedAt) !== expectedMs) return false;
    this.data.set(id, structuredClone(next));
    return true;
  }
}

const driverDoc = (id: string, over: Doc = {}): Doc => ({
  driverId: id,
  personal: { fullName: `Driver ${id}`, contactPhone: '+919876543210' },
  identity: { licenceExpiry: '2099-01-01', aadhaarLast4: '9012' },
  kycStatus: 'pending_review',
  bankStatus: 'pending_review',
  createdAt: T0,
  updatedAt: new Date(T0.getTime() - 3_600_000),
  ...over,
});
const shopDoc = (id: string, over: Doc = {}): Doc => ({
  shopId: id,
  personal: { shopName: `Shop ${id}`, ownerName: 'Owner' },
  kycStatus: 'pending_review',
  bankStatus: 'incomplete',
  createdAt: T0,
  updatedAt: new Date(T0.getTime() - 1_800_000),
  ...over,
});

function setup() {
  clock.t = T0.getTime();
  const drivers = new MemoryReviewStore();
  const merchants = new MemoryReviewStore();
  const events = new RecordingEvents();
  const service = new ProfileVerificationService(
    drivers,
    merchants,
    { get: async (id: string) => ({ kycStatus: 'pending_review', who: id }) as never },
    { get: async (id: string) => ({ kycStatus: 'pending_review', who: id }) as never },
    events,
    now
  );
  return { drivers, merchants, events, service };
}

const versionOf = (store: MemoryReviewStore, id: string) => String(ms(store.data.get(id)!.updatedAt));

describe('the review queue', () => {
  it('lists only profiles waiting for review, oldest first, with who and which sections', async () => {
    const { drivers, merchants, service } = setup();
    drivers.data.set('d-new', driverDoc('d-new', { kycStatus: 'pending_review', bankStatus: 'verified', updatedAt: new Date(T0.getTime() - 60_000) }));
    drivers.data.set('d-old', driverDoc('d-old'));
    drivers.data.set('d-done', driverDoc('d-done', { kycStatus: 'verified', bankStatus: 'verified' }));
    drivers.data.set('d-draft', driverDoc('d-draft', { kycStatus: 'incomplete', bankStatus: 'incomplete' }));
    merchants.data.set('s-1', shopDoc('s-1'));

    const items = await service.list();
    expect(items.map((i) => `${i.kind}:${i.ownerId}`)).toEqual(['driver:d-old', 'merchant:s-1', 'driver:d-new']);
    expect(items[0]).toMatchObject({ name: 'Driver d-old', pending: ['kyc', 'bank'], sections: { kyc: 'pending_review', bank: 'pending_review' } });
    expect(items[1]).toMatchObject({ name: 'Shop s-1', pending: ['kyc'] });
    expect(items[2].pending).toEqual(['kyc']);
  });

  it('is empty when nothing is waiting', async () => {
    expect(await setup().service.list()).toEqual([]);
  });
});

describe('opening a profile', () => {
  it('returns the owner-style masked profile, a version token, and flags an expired licence', async () => {
    const { drivers, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    drivers.data.set('d-2', driverDoc('d-2', { identity: { licenceExpiry: '2020-01-01' } }));
    const ok = await service.get('driver', 'd-1');
    expect(ok).toMatchObject({ kind: 'driver', ownerId: 'd-1', name: 'Driver d-1', licenceExpired: false, history: [] });
    expect(ok.version).toBe(versionOf(drivers, 'd-1'));
    expect(ok.profile).toMatchObject({ who: 'd-1' });
    expect((await service.get('driver', 'd-2')).licenceExpired).toBe(true);
    await expect(service.get('driver', 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('deciding', () => {
  const admin = 'admin-1';

  it('approve: marks the section verified, records who/when, tells the person, leaves the other section alone', async () => {
    const { drivers, events, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    const detail = await service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: versionOf(drivers, 'd-1') });

    const saved = drivers.data.get('d-1')!;
    expect(saved).toMatchObject({ kycStatus: 'verified', bankStatus: 'pending_review' });
    expect(saved.kycReview).toMatchObject({ section: 'kyc', decision: 'approved', by: admin });
    expect(detail.sections).toEqual({ kyc: 'verified', bank: 'pending_review' });
    expect(detail.history[0]).toMatchObject({ section: 'kyc', decision: 'approved', reason: null });
    expect(events.calls).toEqual([`kycApproved:driver:d-1:kyc-${T0.getTime()}`]);
  });

  it('bank and KYC are decided separately', async () => {
    const { drivers, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    await service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: versionOf(drivers, 'd-1') });
    clock.t += 1000;
    await service.decide(admin, 'driver', 'd-1', 'bank', { approve: false, reason: 'IFSC does not match the account holder', version: versionOf(drivers, 'd-1') });
    expect(drivers.data.get('d-1')).toMatchObject({ kycStatus: 'verified', bankStatus: 'rejected' });
    expect((await service.get('driver', 'd-1')).history.map((h) => `${h.section}:${h.decision}`)).toEqual(['bank:rejected', 'kyc:approved']);
  });

  it('reject needs a real reason; with one it is stored for the applicant and the person is told', async () => {
    const { merchants, events, service } = setup();
    merchants.data.set('s-1', shopDoc('s-1'));
    const v = versionOf(merchants, 's-1');
    for (const reason of [undefined, '', '  ', 'no', 'x'.repeat(201)]) {
      await expect(service.decide(admin, 'merchant', 's-1', 'kyc', { approve: false, reason, version: v })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(merchants.data.get('s-1')!.kycStatus).toBe('pending_review');
    expect(events.calls).toEqual([]);

    await service.decide(admin, 'merchant', 's-1', 'kyc', { approve: false, reason: '  PAN image is unreadable  ', version: v });
    const saved = merchants.data.get('s-1')!;
    expect(saved).toMatchObject({ kycStatus: 'rejected' });
    expect(saved.kycReview).toMatchObject({ decision: 'rejected', reason: 'PAN image is unreadable' });
    expect(events.calls).toHaveLength(1);
    expect(events.calls[0]).toMatch(/^kycRejected:merchant:s-1:kyc-/);
  });

  it('the applicant sees the reason only while the section is rejected', () => {
    const rec = { section: 'kyc', decision: 'rejected', reason: 'Blurry photo', by: 'a', at: T0 } as const;
    expect(reviewNote('rejected', rec)).toBe('Blurry photo');
    expect(reviewNote('pending_review', rec)).toBeNull(); // they fixed and resubmitted
    expect(reviewNote('verified', rec)).toBeNull();
    expect(reviewNote('rejected', undefined)).toBeNull();
    expect(reviewNote('rejected', { ...rec, decision: 'approved' })).toBeNull();
  });

  it('refuses a decision on a profile that changed since the admin opened it, and applies nothing', async () => {
    const { drivers, events, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    const stale = versionOf(drivers, 'd-1');
    drivers.data.set('d-1', { ...drivers.data.get('d-1')!, updatedAt: new Date(T0.getTime() - 1000) }); // the applicant edited
    await expect(service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: stale })).rejects.toMatchObject({ statusCode: 409 });
    expect(drivers.data.get('d-1')!.kycStatus).toBe('pending_review');
    expect(events.calls).toEqual([]);
  });

  it('is safe against an edit landing in the middle of the decision (atomic compare-and-set)', async () => {
    const { drivers, events, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    const v = versionOf(drivers, 'd-1');
    drivers.beforeReplace = () => drivers.data.set('d-1', { ...drivers.data.get('d-1')!, personal: { fullName: 'Swapped Identity' }, updatedAt: new Date(T0.getTime() - 500) });
    await expect(service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: v })).rejects.toMatchObject({ statusCode: 409 });
    expect(drivers.data.get('d-1')).toMatchObject({ kycStatus: 'pending_review', personal: { fullName: 'Swapped Identity' } });
    expect(events.calls).toEqual([]);
  });

  it('only a section that is waiting can be decided; a second decision is refused', async () => {
    const { drivers, events, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1', { bankStatus: 'incomplete' }));
    drivers.data.set('d-2', driverDoc('d-2', { kycStatus: 'verified' }));
    await expect(service.decide(admin, 'driver', 'd-1', 'bank', { approve: true, version: versionOf(drivers, 'd-1') })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.decide(admin, 'driver', 'd-2', 'kyc', { approve: true, version: versionOf(drivers, 'd-2') })).rejects.toMatchObject({ statusCode: 409 });

    await service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: versionOf(drivers, 'd-1') });
    await expect(service.decide('admin-2', 'driver', 'd-1', 'kyc', { approve: false, reason: 'changed my mind', version: versionOf(drivers, 'd-1') })).rejects.toMatchObject({ statusCode: 409 });
    expect(drivers.data.get('d-1')!.kycStatus).toBe('verified');
    expect(events.calls).toHaveLength(1);
  });

  it('a driver with an expired licence cannot be approved, but can be rejected', async () => {
    const { drivers, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1', { identity: { licenceExpiry: '2026-10-05' } }));
    const v = versionOf(drivers, 'd-1');
    await expect(service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: v })).rejects.toMatchObject({ statusCode: 409 });
    await service.decide(admin, 'driver', 'd-1', 'kyc', { approve: false, reason: 'Licence has expired', version: v });
    expect(drivers.data.get('d-1')!.kycStatus).toBe('rejected');
  });

  it('404 for an unknown profile; a bad or missing version is refused', async () => {
    const { drivers, service } = setup();
    drivers.data.set('d-1', driverDoc('d-1'));
    await expect(service.decide(admin, 'driver', 'nope', 'kyc', { approve: true, version: '1' })).rejects.toMatchObject({ statusCode: 404 });
    for (const version of ['', 'abc', '123']) {
      await expect(service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version })).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(drivers.data.get('d-1')!.kycStatus).toBe('pending_review');
  });

  it('keeps a bounded history', async () => {
    const { drivers, service } = setup();
    const history = Array.from({ length: 60 }, (_, i) => ({ section: 'kyc', decision: 'rejected', reason: `r${i}`, by: 'a', at: new Date(T0.getTime() + i) }));
    drivers.data.set('d-1', driverDoc('d-1', { reviewHistory: history }));
    await service.decide(admin, 'driver', 'd-1', 'kyc', { approve: true, version: versionOf(drivers, 'd-1') });
    expect((drivers.data.get('d-1')!.reviewHistory as unknown[]).length).toBe(50);
  });
});
