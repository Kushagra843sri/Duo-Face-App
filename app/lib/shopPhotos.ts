import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { confirmShopImage, requestShopImageUpload } from '@/api/shopImages';
import type { ShopImages } from '@/api/shopImages';
import { previewRole } from '@/lib/preview';
import { addPreviewShopImage } from '@/lib/previewShopImages';

export type PhotoSource = 'camera' | 'library';

/** Thrown with a merchant-facing message. */
export class ShopPhotoError extends Error {}

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Takes (or picks) a shop photo and uploads it: the server signs a request for this shop's own
 * Cloudinary folder, the phone uploads straight to Cloudinary, then the server verifies and records it.
 * @returns the updated list, or null if the merchant cancelled.
 */
export async function pickAndUploadShopPhoto(source: PhotoSource): Promise<ShopImages | null> {
  const permission = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new ShopPhotoError(source === 'camera' ? 'Camera permission is needed. Allow it in your phone Settings and try again.' : 'Photo library permission is needed.');
  }

  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [4, 3], quality: 0.7, exif: false };
  let result: ImagePicker.ImagePickerResult;
  try {
    result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  } catch {
    throw new ShopPhotoError('The camera could not be opened on this device.');
  }
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;

  if (previewRole) return addPreviewShopImage(asset.uri);

  if (asset.fileSize && asset.fileSize > MAX_BYTES) throw new ShopPhotoError('That photo is too large (max 10 MB). Try again.');
  const sig = await requestShopImageUpload();

  const form = new FormData();
  if (Platform.OS === 'web') {
    form.append('file', await (await fetch(asset.uri)).blob());
  } else {
    form.append('file', { uri: asset.uri, name: asset.fileName ?? 'shop.jpg', type: asset.mimeType ?? 'image/jpeg' } as unknown as Blob);
  }
  form.append('api_key', sig.apiKey);
  form.append('timestamp', String(sig.timestamp));
  form.append('signature', sig.signature);
  form.append('folder', sig.folder);
  form.append('allowed_formats', sig.allowedFormats);

  let uploaded: { public_id?: string; version?: number };
  try {
    const res = await fetch(sig.uploadUrl, { method: 'POST', body: form });
    if (!res.ok) throw new Error('upload failed');
    uploaded = (await res.json()) as { public_id?: string; version?: number };
  } catch {
    throw new ShopPhotoError('The upload failed. Check your connection and try again.');
  }
  if (!uploaded.public_id || !uploaded.version) throw new ShopPhotoError('The upload failed. Please try again.');
  return confirmShopImage(uploaded.public_id, uploaded.version);
}
