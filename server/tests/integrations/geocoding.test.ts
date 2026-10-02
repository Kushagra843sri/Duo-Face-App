import { loadGeocodingConfig } from '../../src/config/geocoding';
import type { GeocodingConfig } from '../../src/config/geocoding';
import { hashNormalizedAddress, normalizeAddress } from '../../src/integrations/geocoding/addressNormalization';
import { CachedDeliveryGeocoder } from '../../src/integrations/geocoding/CachedDeliveryGeocoder';
import { createDeliveryGeocoder } from '../../src/integrations/geocoding/createDeliveryGeocoder';
import { UnconfiguredDeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import { GeocodingError, OpenCageGeocodingProvider } from '../../src/integrations/geocoding/OpenCageGeocodingProvider';
import type { GeocodingProvider } from '../../src/integrations/geocoding/OpenCageGeocodingProvider';
import type { DeliveryDestinationStore } from '../../src/integrations/firebase/FirestoreDeliveryDestinationStore';

const ADDRESS = '12/A, MG Road,  Connaught Place, New Delhi 110001';

describe('address normalization and hashing', () => {
  it('is deterministic and ignores case, punctuation and whitespace', () => {
    expect(normalizeAddress('12/A, MG Road,  Delhi.')).toBe('12 a mg road delhi');
    expect(normalizeAddress('  12 a MG-road (Delhi)  ')).toBe('12 a mg road delhi');
    expect(normalizeAddress(ADDRESS)).toBe(normalizeAddress(ADDRESS));
  });

  it('applies unicode NFKC folding and keeps non-latin letters', () => {
    expect(normalizeAddress('ＭＧ Road')).toBe('mg road');
    expect(normalizeAddress('गांधी नगर, दिल्ली')).toBe('गांधी नगर दिल्ली');
  });

  it('does not treat different tokens or order as the same address', () => {
    expect(normalizeAddress('12 MG Road')).not.toBe(normalizeAddress('MG Road 12'));
    expect(hashNormalizedAddress('a b')).not.toBe(hashNormalizedAddress('a c'));
  });

  it('hashes with SHA-256 hex, deterministically, without leaking the address', () => {
    const hash = hashNormalizedAddress(normalizeAddress(ADDRESS));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashNormalizedAddress(normalizeAddress('12 a mg road connaught place new delhi 110001')));
    expect(hash).not.toContain('delhi');
  });

  it('normalizes punctuation-only input to empty', () => {
    expect(normalizeAddress(' ,,, --- ')).toBe('');
  });
});

describe('loadGeocodingConfig', () => {
  it('is null (geocoding off) without an API key, or with a blank one', () => {
    expect(loadGeocodingConfig({})).toBeNull();
    expect(loadGeocodingConfig({ OPENCAGE_API_KEY: '   ' })).toBeNull();
  });

  it('applies defaults and normalizes the country code', () => {
    expect(loadGeocodingConfig({ OPENCAGE_API_KEY: 'k', GEOCODER_COUNTRY_CODE: 'IN' })).toEqual({
      apiKey: 'k',
      countryCode: 'in',
      minConfidence: 7,
      timeoutMs: 5000,
    });
  });

  it('is safely off (null) when an optional setting is malformed', () => {
    expect(loadGeocodingConfig({ OPENCAGE_API_KEY: 'k', GEOCODER_MIN_CONFIDENCE: '99' })).toBeNull();
    expect(loadGeocodingConfig({ OPENCAGE_API_KEY: 'k', GEOCODER_COUNTRY_CODE: 'india' })).toBeNull();
  });

  it('createDeliveryGeocoder returns the unconfigured geocoder without a key', async () => {
    const geocoder = createDeliveryGeocoder({});
    expect(geocoder).toBeInstanceOf(UnconfiguredDeliveryGeocoder);
    expect(await geocoder.geocode(ADDRESS)).toBeNull();
  });
});

const config: GeocodingConfig = { apiKey: 'test-key-123', countryCode: 'in', minConfidence: 7, timeoutMs: 1000 };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function providerWith(fetchImpl: (url: URL, init?: RequestInit) => Promise<Response>) {
  return new OpenCageGeocodingProvider(config, fetchImpl as unknown as typeof fetch);
}

const okBody = (overrides: Record<string, unknown> = {}) => ({
  results: [{ geometry: { lat: 28.6315, lng: 77.2167 }, confidence: 9, ...overrides }],
});

async function categoryOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GeocodingError) return err.category;
    throw err;
  }
  return 'none';
}

describe('OpenCageGeocodingProvider', () => {
  it('returns coordinates and precision for a valid response and sends the documented params', async () => {
    let seen: URL | undefined;
    const provider = providerWith(async (url) => {
      seen = url;
      return jsonResponse(200, okBody());
    });

    await expect(provider.geocode(ADDRESS)).resolves.toEqual({ latitude: 28.6315, longitude: 77.2167, precision: 9 });
    expect(seen!.origin + seen!.pathname).toBe('https://api.opencagedata.com/geocode/v1/json');
    expect(seen!.searchParams.get('q')).toBe(ADDRESS);
    expect(seen!.searchParams.get('no_record')).toBe('1');
    expect(seen!.searchParams.get('limit')).toBe('1');
    expect(seen!.searchParams.get('countrycode')).toBe('in');
  });

  it.each([
    ['no result', async () => jsonResponse(200, { results: [] }), 'no_result'],
    ['malformed body', async () => jsonResponse(200, { unexpected: true }), 'malformed'],
    ['non-JSON body', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response, 'malformed'],
    ['non-numeric coordinates', async () => jsonResponse(200, okBody({ geometry: { lat: '28', lng: '77' } })), 'invalid_coordinates'],
    ['out-of-range latitude', async () => jsonResponse(200, okBody({ geometry: { lat: 95, lng: 77 } })), 'invalid_coordinates'],
    ['out-of-range longitude', async () => jsonResponse(200, okBody({ geometry: { lat: 28, lng: 190 } })), 'invalid_coordinates'],
    ['low confidence', async () => jsonResponse(200, okBody({ confidence: 3 })), 'low_confidence'],
    ['missing confidence', async () => jsonResponse(200, okBody({ confidence: undefined })), 'low_confidence'],
    ['401', async () => jsonResponse(401, {}), 'auth'],
    ['403', async () => jsonResponse(403, {}), 'auth'],
    ['429', async () => jsonResponse(429, {}), 'rate_limited'],
    ['402 quota', async () => jsonResponse(402, {}), 'rate_limited'],
    ['400', async () => jsonResponse(400, {}), 'invalid_address'],
    ['500', async () => jsonResponse(500, {}), 'unavailable'],
    ['network failure', async () => { throw new TypeError('fetch failed'); }, 'unavailable'],
    ['timeout', async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 'timeout'],
  ])('provider %s -> mapped category', async (_name, respond, expected) => {
    const provider = providerWith(respond as () => Promise<Response>);
    expect(await categoryOf(provider.geocode(ADDRESS))).toBe(expected);
  });

  it('never puts the API key, URL or address into the error', async () => {
    const provider = providerWith(async () => {
      throw new Error(`fetch failed https://api.opencagedata.com/?key=${config.apiKey}&q=${ADDRESS}`);
    });
    const error = await provider.geocode(ADDRESS).catch((e: Error) => e);
    expect(String((error as Error).message) + JSON.stringify(error)).not.toContain('test-key-123');
    expect(String((error as Error).message)).not.toContain('Connaught');
  });
});

function fakeStore(initial: Record<string, Record<string, unknown>> = {}) {
  const data = new Map(Object.entries(initial));
  const store: DeliveryDestinationStore & { data: Map<string, Record<string, unknown>>; creates: number; replaces: number } = {
    data,
    creates: 0,
    replaces: 0,
    async get(id) {
      return data.get(id) ?? null;
    },
    async createIfAbsent(id, value) {
      if (data.has(id)) return false;
      store.creates++;
      data.set(id, value);
      return true;
    },
    async replace(id, value) {
      store.replaces++;
      data.set(id, value);
    },
  };
  return store;
}

function fakeProvider(behavior: () => Promise<{ latitude: number; longitude: number; precision: number }>) {
  const provider: GeocodingProvider & { calls: number } = {
    name: 'fake',
    calls: 0,
    async geocode() {
      provider.calls++;
      return behavior();
    },
  };
  return provider;
}

const good = async () => ({ latitude: 28.6, longitude: 77.2, precision: 9 });
const hash = hashNormalizedAddress(normalizeAddress(ADDRESS));

describe('CachedDeliveryGeocoder', () => {
  let warn: jest.SpyInstance;
  let logged: () => string;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    logged = () => JSON.stringify([warn.mock.calls, error.mock.calls, log.mock.calls]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('cache miss: calls the provider once, returns coordinates and caches a minimal document', async () => {
    const store = fakeStore();
    const provider = fakeProvider(good);
    const geocoder = new CachedDeliveryGeocoder(store, provider);

    expect(await geocoder.geocode(ADDRESS)).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(provider.calls).toBe(1);

    const doc = store.data.get(hash)!;
    expect(Object.keys(doc).sort()).toEqual(
      ['addressHash', 'createdAt', 'destinationId', 'latitude', 'longitude', 'normalizedAddress', 'precision', 'provider', 'updatedAt']
    );
    expect(doc.provider).toBe('fake');
    expect(doc.normalizedAddress).toBe(normalizeAddress(ADDRESS));
  });

  it('cache hit: does not call the provider, and an equivalent spelling also hits', async () => {
    const store = fakeStore();
    const provider = fakeProvider(good);
    const geocoder = new CachedDeliveryGeocoder(store, provider);
    await geocoder.geocode(ADDRESS);

    expect(await geocoder.geocode('12 a mg road connaught place, NEW DELHI 110001')).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(provider.calls).toBe(1);
    expect(store.creates).toBe(1);
  });

  it('does not overwrite a valid cached destination', async () => {
    const store = fakeStore();
    const geocoder = new CachedDeliveryGeocoder(store, fakeProvider(good));
    await geocoder.geocode(ADDRESS);
    const before = store.data.get(hash);
    await geocoder.geocode(ADDRESS);
    await geocoder.geocode(ADDRESS);
    expect(store.data.get(hash)).toBe(before);
    expect(store.replaces).toBe(0);
  });

  it.each(['no_result', 'rate_limited', 'timeout', 'malformed', 'invalid_coordinates', 'auth'] as const)(
    'provider failure (%s) returns null and caches nothing',
    async (category) => {
      const store = fakeStore();
      const geocoder = new CachedDeliveryGeocoder(store, fakeProvider(async () => { throw new GeocodingError(category); }));
      expect(await geocoder.geocode(ADDRESS)).toBeNull();
      expect(store.data.size).toBe(0);
    }
  );

  it('an unexpected provider exception also yields null', async () => {
    const geocoder = new CachedDeliveryGeocoder(fakeStore(), fakeProvider(async () => { throw new Error('boom'); }));
    expect(await geocoder.geocode(ADDRESS)).toBeNull();
  });

  it('a malformed cached document is never exposed, and is repaired through the service path', async () => {
    const store = fakeStore({ [hash]: { destinationId: hash, addressHash: hash, latitude: 999, longitude: 'x' } });
    const provider = fakeProvider(good);
    const geocoder = new CachedDeliveryGeocoder(store, provider);

    expect(await geocoder.geocode(ADDRESS)).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(provider.calls).toBe(1);
    expect(store.replaces).toBe(1);
    expect(store.data.get(hash)!.latitude).toBe(28.6);
  });

  it('a malformed cached document with a failing provider yields null (not the bad data)', async () => {
    const store = fakeStore({ [hash]: { destinationId: hash, latitude: 999, longitude: 0 } });
    const geocoder = new CachedDeliveryGeocoder(store, fakeProvider(async () => { throw new GeocodingError('timeout'); }));
    expect(await geocoder.geocode(ADDRESS)).toBeNull();
  });

  it('a cached document whose normalizedAddress does not match is not served', async () => {
    const store = fakeStore({
      [hash]: {
        destinationId: hash, addressHash: hash, normalizedAddress: 'some other address', latitude: 1, longitude: 2,
        provider: 'x', createdAt: new Date(), updatedAt: new Date(),
      },
    });
    const provider = fakeProvider(good);
    expect(await new CachedDeliveryGeocoder(store, provider).geocode(ADDRESS)).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(provider.calls).toBe(1);
  });

  it('collapses concurrent lookups of the same address into one provider call', async () => {
    const store = fakeStore();
    const provider = fakeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { latitude: 1, longitude: 2, precision: 9 };
    });
    const geocoder = new CachedDeliveryGeocoder(store, provider);

    const results = await Promise.all([geocoder.geocode(ADDRESS), geocoder.geocode(ADDRESS), geocoder.geocode(ADDRESS)]);
    expect(results).toEqual([results[0], results[0], results[0]]);
    expect(provider.calls).toBe(1);
    expect(store.creates).toBe(1);
  });

  it('still returns coordinates when the cache write fails, and returns null-safe on cache read failure + provider failure', async () => {
    const brokenStore: DeliveryDestinationStore = {
      get: async () => { throw new Error('firestore down'); },
      createIfAbsent: async () => { throw new Error('firestore down'); },
      replace: async () => { throw new Error('firestore down'); },
    };
    expect(await new CachedDeliveryGeocoder(brokenStore, fakeProvider(good)).geocode(ADDRESS)).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(await new CachedDeliveryGeocoder(brokenStore, fakeProvider(async () => { throw new GeocodingError('timeout'); })).geocode(ADDRESS)).toBeNull();
  });

  it('returns null without calling anything for an empty/punctuation-only address', async () => {
    const provider = fakeProvider(good);
    expect(await new CachedDeliveryGeocoder(fakeStore(), provider).geocode(' ,,, ')).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it('never writes the raw address (or its parts) to any log, on any path', async () => {
    const paths: Array<CachedDeliveryGeocoder> = [
      new CachedDeliveryGeocoder(fakeStore(), fakeProvider(good)),
      new CachedDeliveryGeocoder(fakeStore(), fakeProvider(async () => { throw new GeocodingError('rate_limited'); })),
      new CachedDeliveryGeocoder(fakeStore({ [hash]: { bad: true } }), fakeProvider(good)),
    ];
    for (const geocoder of paths) await geocoder.geocode(ADDRESS);

    const output = logged();
    expect(output).not.toContain('Connaught');
    expect(output).not.toContain('MG Road');
    expect(output).not.toContain('110001');
    expect(output).toContain(hash); // hash + category only
  });
});
