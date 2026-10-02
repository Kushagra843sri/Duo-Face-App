import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { confirmPhotoUpload, requestPhotoUpload } from '@/api/profile';
import type { PhotoKind } from '@/api/profile';
import { previewRole } from '@/lib/preview';

export type PhotoSource = 'camera' | 'library';

/** Thrown with a driver/merchant-facing message. */
export class PhotoError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

function normalizeType(type: string | undefined | null): string {
  const lower = (type ?? 'image/jpeg').toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

/**
 * Takes (or, where allowed, picks) a photo and uploads it straight to the
 * private bucket with a signed URL, then confirms it with the server
 * (docs/decisions/029). The 'library' source is never offered for live-photo
 * kinds (selfie, vehicle): those only call launchCameraAsync.
 *
 * @returns false if the user cancelled.
 */
export async function captureAndUpload(role: 'driver' | 'merchant', kind: PhotoKind, source: PhotoSource): Promise<boolean> {
  if (previewRole) {
    // No camera or bucket in preview: exercise the same API calls so the screen behaves like the real thing.
    const grant = await requestPhotoUpload(role, kind, 'image/jpeg', 1000);
    await confirmPhotoUpload(role, kind, grant.objectKey);
    return true;
  }

  if (Platform.OS === 'web' && source === 'camera') {
    throw new PhotoError('Taking a live photo needs the installed app.');
  }

  const permission = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new PhotoError(source === 'camera' ? 'Camera permission is needed to take this photo.' : 'Photo library permission is needed.');
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.7, // keeps phone photos comfortably under the 5 MB limit
    exif: false,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ ...options, cameraType: kind === 'selfie' ? ImagePicker.CameraType.front : ImagePicker.CameraType.back })
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return false;

  const asset = result.assets[0];
  const blob = await (await fetch(asset.uri)).blob();
  const contentType = normalizeType(asset.mimeType ?? blob.type);
  if (!ALLOWED.includes(contentType)) throw new PhotoError('Please use a JPEG, PNG or WebP photo.');
  if (blob.size > MAX_BYTES) throw new PhotoError('That photo is too large (max 5 MB). Try again.');

  const grant = await requestPhotoUpload(role, kind, contentType, blob.size);
  // The signed URL only accepts exactly this type and length, straight to the private bucket.
  const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
  if (!put.ok) throw new PhotoError('The upload failed. Please try again.');
  await confirmPhotoUpload(role, kind, grant.objectKey);
  return true;
}
