import { createImageHost } from '../integrations/cloudinary/CloudinaryImageHost';
import type { ImageHost, UploadSignature } from '../integrations/cloudinary/CloudinaryImageHost';
import { FirestoreShopListingStore } from '../integrations/firebase/FirestoreShopListingStore';
import type { ShopListingStore } from '../integrations/firebase/FirestoreShopListingStore';
import { AppError } from '../middleware/errorHandler';

export const MAX_SHOP_IMAGES = 4;

export interface ShopImage {
  /** Last path segment of the public id: what the app uses to remove it. */
  id: string;
  publicId: string;
  url: string;
}

const isImage = (v: unknown): v is ShopImage =>
  typeof v === 'object' && v !== null && typeof (v as ShopImage).id === 'string' && typeof (v as ShopImage).publicId === 'string' && typeof (v as ShopImage).url === 'string';

/**
 * The storefront photos a shop owner uploads (up to 4) so customers recognise the shop by sight.
 * Stored as an added `images` field on the customer-visible `shops/{id}` record (the first one is
 * mirrored into `imageUrl`), so the owner and the customer always see the same photos.
 * The phone uploads straight to Cloudinary with a server-signed request; the server then verifies
 * the image exists under THIS shop's folder before recording it.
 */
export class ShopImageService {
  constructor(
    private readonly store: ShopListingStore = new FirestoreShopListingStore(),
    private readonly host: ImageHost = createImageHost(),
    private readonly now: () => Date = () => new Date()
  ) {}

  private folder(customerShopId: string) {
    return `duoface/shops/${customerShopId}`;
  }

  private requireHost() {
    if (!this.host.enabled) throw new AppError(503, 'Shop photo upload is not configured.');
  }

  private async load(customerShopId: string | undefined): Promise<{ id: string; images: ShopImage[] }> {
    if (!customerShopId) throw new AppError(409, 'This shop is not listed for customers yet.');
    const doc = await this.store.get(customerShopId);
    if (!doc) throw new AppError(409, 'This shop is not listed for customers yet.');
    return { id: customerShopId, images: Array.isArray(doc.images) ? doc.images.filter(isImage) : [] };
  }

  private async save(customerShopId: string, images: ShopImage[]) {
    await this.store.merge(customerShopId, { images, imageUrl: images[0]?.url ?? '', updatedAt: this.now() });
  }

  async list(customerShopId: string | undefined): Promise<ShopImage[]> {
    return (await this.load(customerShopId)).images;
  }

  async requestUpload(customerShopId: string | undefined): Promise<UploadSignature> {
    this.requireHost();
    const { id, images } = await this.load(customerShopId);
    if (images.length >= MAX_SHOP_IMAGES) throw new AppError(409, `You can add up to ${MAX_SHOP_IMAGES} shop photos. Remove one first.`);
    return this.host.signUpload(this.folder(id), this.now());
  }

  async add(customerShopId: string | undefined, publicId: string, version: number): Promise<ShopImage[]> {
    this.requireHost();
    const { id, images } = await this.load(customerShopId);
    // Only an image that was uploaded into THIS shop's own folder can be attached.
    if (!publicId.startsWith(`${this.folder(id)}/`) || publicId.includes('..')) throw new AppError(400, 'Invalid upload.');
    if (images.some((i) => i.publicId === publicId)) return images;
    if (images.length >= MAX_SHOP_IMAGES) throw new AppError(409, `You can add up to ${MAX_SHOP_IMAGES} shop photos. Remove one first.`);

    const url = this.host.deliveryUrl(publicId, version);
    if (!(await this.host.exists(url))) throw new AppError(409, 'Upload not found. Please try again.');

    const next = [...images, { id: publicId.slice(publicId.lastIndexOf('/') + 1), publicId, url }];
    await this.save(id, next);
    return next;
  }

  async remove(customerShopId: string | undefined, imageId: string): Promise<ShopImage[]> {
    const { id, images } = await this.load(customerShopId);
    const target = images.find((i) => i.id === imageId);
    if (!target) return images;
    const next = images.filter((i) => i.id !== imageId);
    await this.save(id, next);
    if (this.host.enabled) await this.host.destroy(target.publicId).catch(() => {}); // best effort
    return next;
  }
}
