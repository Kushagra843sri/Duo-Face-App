import { randomBytes } from 'crypto';

import { StorageUnavailableError, presignUrl, R2ObjectStorage, UnconfiguredObjectStorage } from '../../src/integrations/storage/R2Storage';
import { loadCommissionBps, loadProfileEncryptionKey, loadR2Config } from '../../src/config/profile';
import { FieldCrypto, maskLast } from '../../src/services/fieldCrypto';
import {
  isAdultDob,
  isFutureDate,
  isValidAadhaar,
  isValidBankAccount,
  isValidFssai,
  isValidGstin,
  isValidIfsc,
  isValidLicenceNumber,
  isValidPan,
  isValidPhone,
  isValidPincode,
  isValidUpi,
  isValidVehicleNumber,
  verhoeffCheckDigit,
} from '../../src/validators/indianIds';

const validAadhaar = (base11: string) => `${base11}${verhoeffCheckDigit(base11)}`;

describe('Indian ID validators', () => {
  it('Aadhaar: valid checksum passes, one wrong digit fails, spaces are tolerated', () => {
    const good = validAadhaar('23456789012');
    expect(isValidAadhaar(good)).toBe(true);
    expect(isValidAadhaar(`${good.slice(0, 4)} ${good.slice(4, 8)} ${good.slice(8)}`)).toBe(true);
    const wrong = good.slice(0, 11) + String((Number(good[11]) + 1) % 10);
    expect(isValidAadhaar(wrong)).toBe(false);
  });

  it.each(['', '12345678901', '1234567890123', '023456789012', '123456789012', 'abcdefghijkl'])('Aadhaar rejects %j', (value) => {
    expect(isValidAadhaar(value)).toBe(false);
  });

  it('PAN / IFSC / GSTIN / FSSAI / vehicle / licence / account / UPI / pincode / phone', () => {
    expect(isValidPan('ABCDE1234F')).toBe(true);
    expect(isValidPan('abcde1234f')).toBe(true); // normalised
    expect(['ABCD1234F', 'ABCDE12345', '1BCDE1234F'].some(isValidPan)).toBe(false);

    expect(isValidIfsc('SBIN0001234')).toBe(true);
    expect(isValidIfsc('SBIN1001234')).toBe(false); // 5th char must be 0

    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1XV')).toBe(false);

    expect(isValidFssai('12345678901234')).toBe(true);
    expect(isValidFssai('1234')).toBe(false);

    for (const ok of ['DL1AB1234', 'MH12AB1234', 'KA01A1234', 'dl 1 ab 1234']) expect(isValidVehicleNumber(ok)).toBe(true);
    for (const bad of ['1234', 'DLAB1234', 'DL1AB12']) expect(isValidVehicleNumber(bad)).toBe(false);

    expect(isValidLicenceNumber('DL0420110012345')).toBe(true);
    expect(isValidLicenceNumber('12')).toBe(false);

    expect(isValidBankAccount('123456789')).toBe(true);
    expect(isValidBankAccount('12345678')).toBe(false);
    expect(isValidBankAccount('1234567890123456789')).toBe(false);

    expect(isValidUpi('ravi@oksbi')).toBe(true);
    expect(isValidUpi('ravi')).toBe(false);

    expect(isValidPincode('110001')).toBe(true);
    expect(isValidPincode('011000')).toBe(false);

    expect(isValidPhone('+919876543210')).toBe(true);
    expect(isValidPhone('9876543210')).toBe(false);
  });

  it('date of birth must be a real date and at least 18; licence expiry must be in the future', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(isAdultDob('2008-06-01', now)).toBe(true);
    expect(isAdultDob('2008-06-02', now)).toBe(false);
    expect(isAdultDob('1995-02-30', now)).toBe(false);
    expect(isAdultDob('12/04/1995', now)).toBe(false);
    expect(isFutureDate('2026-06-02', now)).toBe(true);
    expect(isFutureDate('2026-06-01', now)).toBe(false);
    expect(isFutureDate('2099-13-01', now)).toBe(false);
  });
});

describe('FieldCrypto (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const crypto = new FieldCrypto(key);

  it('round-trips and never contains the plaintext', () => {
    const envelope = crypto.encrypt('ABCDE1234F', 'driver:d1:pan');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope).not.toContain('ABCDE1234F');
    expect(crypto.decrypt(envelope, 'driver:d1:pan')).toBe('ABCDE1234F');
  });

  it('uses a fresh nonce every time (same input, different ciphertext)', () => {
    expect(crypto.encrypt('x', 'c')).not.toBe(crypto.encrypt('x', 'c'));
  });

  it('is bound to its context: it cannot be moved to another field or person', () => {
    const envelope = crypto.encrypt('123456789012', 'driver:d1:bank-account');
    expect(() => crypto.decrypt(envelope, 'driver:d2:bank-account')).toThrow();
    expect(() => crypto.decrypt(envelope, 'driver:d1:pan')).toThrow();
  });

  it('detects tampering and a wrong key', () => {
    const envelope = crypto.encrypt('secret', 'c');
    const parts = envelope.split(':');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => crypto.decrypt(parts.join(':'), 'c')).toThrow();
    expect(() => new FieldCrypto(randomBytes(32)).decrypt(envelope, 'c')).toThrow();
  });

  it('needs exactly a 32-byte key; masks keep only the last characters', () => {
    expect(() => new FieldCrypto(Buffer.alloc(16))).toThrow();
    expect(maskLast('ABCDE1234F')).toBe('••••••234F');
  });

  it('config: key must decode to 32 bytes; commission is an integer in range; unset means unconfigured', () => {
    expect(loadProfileEncryptionKey({})).toBeNull();
    expect(loadProfileEncryptionKey({ PROFILE_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toBeNull();
    expect(loadProfileEncryptionKey({ PROFILE_ENCRYPTION_KEY: key.toString('base64') })?.length).toBe(32);
    expect(loadCommissionBps({})).toBeNull();
    expect(loadCommissionBps({ PLATFORM_COMMISSION_BPS: '1000' })).toBe(1000);
    expect(loadCommissionBps({ PLATFORM_COMMISSION_BPS: '10.5' })).toBeNull();
    expect(loadCommissionBps({ PLATFORM_COMMISSION_BPS: '20000' })).toBeNull();
    expect(loadR2Config({})).toBeNull();
  });
});

describe('SigV4 presigning / R2 storage', () => {
  it("matches AWS's published presigned-URL example exactly", () => {
    const url = presignUrl({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
      expiresSeconds: 86400,
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  const config = { accountId: 'acct123', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'private-bucket' };
  const clock = () => new Date('2026-06-01T10:00:00Z');

  it('signs a PUT bound to the content type and exact length, on the private R2 host', () => {
    const storage = new R2ObjectStorage(config, clock);
    const url = new URL(storage.presignPut({ key: 'driver/d1/selfie/abc.jpg', contentType: 'image/jpeg', contentLength: 1234, expiresSeconds: 300 }));
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/private-bucket/driver/d1/selfie/abc.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260601T100000Z');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different length or type produces a different signature (so a swapped upload is refused by R2)', () => {
    const storage = new R2ObjectStorage(config, clock);
    const sig = (type: string, length: number) =>
      new URL(storage.presignPut({ key: 'k.jpg', contentType: type, contentLength: length, expiresSeconds: 300 })).searchParams.get('X-Amz-Signature');
    expect(sig('image/jpeg', 100)).not.toBe(sig('image/jpeg', 101));
    expect(sig('image/jpeg', 100)).not.toBe(sig('image/png', 100));
  });

  it('head reports size/type, null for a missing object, and category-only errors otherwise', async () => {
    const respond = (status: number, headers: Record<string, string> = {}) =>
      (async () => ({ ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } })) as never;
    expect(await new R2ObjectStorage(config, clock, respond(200, { 'content-length': '999', 'content-type': 'image/png' })).head('k')).toEqual({ size: 999, contentType: 'image/png' });
    expect(await new R2ObjectStorage(config, clock, respond(404)).head('k')).toBeNull();
    await expect(new R2ObjectStorage(config, clock, respond(500)).head('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(
      new R2ObjectStorage(config, clock, (async () => {
        throw new Error('ECONNRESET https://acct123.r2.cloudflarestorage.com/secret?X-Amz-Signature=abc');
      }) as never).head('k')
    ).rejects.toMatchObject({ message: 'storage unavailable' });
  });

  it('unconfigured storage refuses everything without a URL or credential in the error', async () => {
    const storage = new UnconfiguredObjectStorage();
    expect(storage.enabled).toBe(false);
    expect(() => storage.presignGet()).toThrow(StorageUnavailableError);
    await expect(storage.head()).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
