import type { ShopImage, ShopImages } from '@/api/shopImages';

/** In-memory shop photos for development UI preview (no Cloudinary there). Resets on reload. */
const MAX = 4;
let images: ShopImage[] = [];
let counter = 0;

export const previewShopImages = (): ShopImages => ({ max: MAX, images: [...images] });

export function addPreviewShopImage(uri: string): ShopImages {
  if (images.length < MAX) {
    counter += 1;
    images.push({ id: `preview-${counter}`, publicId: `preview/${counter}`, url: uri });
  }
  return previewShopImages();
}

export function previewShopImageRoute(method: string, pathname: string): unknown {
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== 'merchant' || seg[1] !== 'shop' || seg[2] !== 'images') return undefined;
  if (method === 'GET' && !seg[3]) return previewShopImages();
  if (method === 'DELETE' && seg[3]) {
    images = images.filter((i) => i.id !== seg[3]);
    return previewShopImages();
  }
  return undefined;
}
