import { apiRequest } from '@/api/client';

/** Mirrors the server's /merchant/shop/images (server/src/services/shopImageService.ts). */
export interface ShopImage {
  id: string;
  publicId: string;
  url: string;
}

export interface ShopImages {
  max: number;
  images: ShopImage[];
}

export interface UploadSignature {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  allowedFormats: string;
}

export const getShopImages = () => apiRequest<ShopImages>('/merchant/shop/images');

export const requestShopImageUpload = () => apiRequest<UploadSignature>('/merchant/shop/images/upload-signature', { method: 'POST' });

export const confirmShopImage = (publicId: string, version: number) =>
  apiRequest<ShopImages>('/merchant/shop/images', { method: 'POST', body: JSON.stringify({ publicId, version }) });

export const removeShopImage = (imageId: string) => apiRequest<ShopImages>(`/merchant/shop/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' });
