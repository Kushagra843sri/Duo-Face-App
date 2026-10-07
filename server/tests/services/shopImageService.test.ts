import { signParams } from '../../src/integrations/cloudinary/CloudinaryImageHost';
import type { ImageHost } from '../../src/integrations/cloudinary/CloudinaryImageHost';
import type { ShopListingStore } from '../../src/integrations/firebase/FirestoreShopListingStore';
import { CustomerCatalogService } from '../../src/services/customerCatalogService';
import { MAX_SHOP_IMAGES, ShopImageService } from '../../src/services/shopImageService';

class FakeStore implements ShopListingStore {
  docs = new Map<string, Record<string, unknown>>();
  async get(id: string) {
    const d = this.docs.get(id);
    return d ? { ...d, id } : null;
  }
  async merge(id: string, data: Record<string, unknown>) {
    this.docs.set(id, { ...(this.docs.get(id) ?? {}), ...data });
  }
}

class FakeHost implements ImageHost {
  enabled = true;
  existing = true;
  destroyed: string[] = [];
  signUpload(folder: string) {
    return { uploadUrl: 'https://upload', apiKey: 'k', timestamp: 1, signature: 's', folder, allowedFormats: 'jpg' };
  }
  deliveryUrl(publicId: string, version: number) {
    return `https://cdn.example/v${version}/${publicId}`;
  }
  async exists() {
    return this.existing;
  }
  async destroy(publicId: string) {
    this.destroyed.push(publicId);
  }
}

const SHOP = 'shop-1';
const pid = (n: number, shop = SHOP) => `duoface/shops/${shop}/img${n}`;

function setup() {
  const store = new FakeStore();
  store.docs.set(SHOP, { name: 'Sharma Kirana', isActive: true });
  const host = new FakeHost();
  return { store, host, service: new ShopImageService(store, host, () => new Date('2026-01-01T00:00:00Z')) };
}

describe('ShopImageService', () => {
  it('signs uploads into the shop\'s own folder only', async () => {
    const { service } = setup();
    expect((await service.requestUpload(SHOP)).folder).toBe('duoface/shops/shop-1');
  });

  it('records photos on the shop and mirrors the first one into imageUrl', async () => {
    const { service, store } = setup();
    await service.add(SHOP, pid(1), 11);
    await service.add(SHOP, pid(2), 12);
    const doc = store.docs.get(SHOP)!;
    expect((doc.images as unknown[]).length).toBe(2);
    expect(doc.imageUrl).toBe(`https://cdn.example/v11/${pid(1)}`);
  });

  it('rejects an image from another shop\'s folder or a path trick', async () => {
    const { service } = setup();
    await expect(service.add(SHOP, pid(1, 'other-shop'), 1)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.add(SHOP, `duoface/shops/${SHOP}/../other/x`, 1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an image that was never really uploaded', async () => {
    const { service, host } = setup();
    host.existing = false;
    await expect(service.add(SHOP, pid(1), 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it(`allows at most ${MAX_SHOP_IMAGES} photos`, async () => {
    const { service } = setup();
    for (let i = 1; i <= MAX_SHOP_IMAGES; i++) await service.add(SHOP, pid(i), i);
    await expect(service.add(SHOP, pid(99), 1)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.requestUpload(SHOP)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is idempotent when the same image is confirmed twice', async () => {
    const { service } = setup();
    await service.add(SHOP, pid(1), 1);
    expect(await service.add(SHOP, pid(1), 1)).toHaveLength(1);
  });

  it('removes a photo, promotes the next as cover and deletes it from the host', async () => {
    const { service, store, host } = setup();
    await service.add(SHOP, pid(1), 1);
    await service.add(SHOP, pid(2), 2);
    await service.remove(SHOP, 'img1');
    expect(host.destroyed).toEqual([pid(1)]);
    expect(store.docs.get(SHOP)!.imageUrl).toBe(`https://cdn.example/v2/${pid(2)}`);
    await service.remove(SHOP, 'img2');
    expect(store.docs.get(SHOP)!.imageUrl).toBe('');
  });

  it('answers 503 when Cloudinary is not configured, 409 when the shop is not listed', async () => {
    const { service, host } = setup();
    await expect(service.list(undefined)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.list('missing')).rejects.toMatchObject({ statusCode: 409 });
    host.enabled = false;
    await expect(service.requestUpload(SHOP)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('Cloudinary signing', () => {
  it('matches the documented example', () => {
    // From Cloudinary docs: sha1("eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510abcd")
    expect(signParams({ timestamp: 1315060510, public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' }, 'abcd')).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });
});

describe('customer shop list photos', () => {
  it('shows only https photo URLs, at most 4', async () => {
    const store = {
      listShops: async () => [
        { id: 's1', name: 'A', images: [{ url: 'https://a/1' }, { url: 'http://insecure' }, { nope: 1 }, { url: 'https://a/2' }, { url: 'https://a/3' }, { url: 'https://a/4' }, { url: 'https://a/5' }] },
        { id: 's2', name: 'B' },
      ],
    };
    const shops = await new CustomerCatalogService(store as never, {} as never).listShops();
    expect(shops.find((s) => s.shopId === 's1')!.images).toEqual(['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4']);
    expect(shops.find((s) => s.shopId === 's2')!.images).toEqual([]);
  });
});
