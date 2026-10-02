import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import { confirmPhotoUpload, requestPhotoUpload } from '@/api/profile';
import type { PhotoKind } from '@/api/profile';
import { previewRole } from '@/lib/preview';
import { setPreviewPhotoUri } from '@/lib/previewProfiles';

export type PhotoSource = 'camera' | 'library';
type Role = 'driver' | 'merchant';

/** Thrown with a driver/merchant-facing message. */
export class PhotoError extends Error {}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
/** Remembers which slot the camera was opened for, in case Android kills the app while it is open. */
const PENDING_KEY = 'duo-face:pending-photo';

function normalizeType(type: string | undefined | null): string {
  const lower = (type ?? 'image/jpeg').toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

/** Uploads a captured/picked image straight to the private bucket with a signed URL, then confirms it. */
async function uploadAsset(role: Role, kind: PhotoKind, asset: ImagePicker.ImagePickerAsset): Promise<void> {
  if (previewRole) {
    // No bucket in preview: keep the real photo on screen and run the same API calls against sample data.
    setPreviewPhotoUri(role, kind, asset.uri);
    const grant = await requestPhotoUpload(role, kind, 'image/jpeg', 1000);
    await confirmPhotoUpload(role, kind, grant.objectKey);
    return;
  }

  const blob = await (await fetch(asset.uri)).blob();
  const contentType = normalizeType(asset.mimeType ?? blob.type);
  if (!ALLOWED.includes(contentType)) throw new PhotoError('Please use a JPEG, PNG or WebP photo.');
  if (blob.size > MAX_BYTES) throw new PhotoError('That photo is too large (max 5 MB). Try again.');

  const grant = await requestPhotoUpload(role, kind, contentType, blob.size);
  // The signed URL only accepts exactly this type and length.
  const put = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
  if (!put.ok) throw new PhotoError('The upload failed. Please try again.');
  await confirmPhotoUpload(role, kind, grant.objectKey);
}

/**
 * Takes (or, where allowed, picks) a photo and uploads it (docs/decisions/029).
 * The 'library' source is never offered for live-photo kinds (selfie,
 * vehicle): those only call launchCameraAsync. In preview mode the real
 * camera still opens; only the upload is simulated.
 *
 * @returns false if the user cancelled.
 */
export async function captureAndUpload(role: Role, kind: PhotoKind, source: PhotoSource): Promise<boolean> {
  if (Platform.OS === 'web' && source === 'camera' && !previewRole) {
    throw new PhotoError('Taking a live photo needs the installed app.');
  }

  const permission = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new PhotoError(source === 'camera' ? 'Camera permission is needed. Allow it in your phone Settings and try again.' : 'Photo library permission is needed.');
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.7, // keeps phone photos comfortably under the 5 MB limit
    exif: false,
  };

  // Android may destroy this app while the camera is in front; remember what we were doing so it can be finished on return.
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ role, kind })).catch(() => {});
  let result: ImagePicker.ImagePickerResult;
  try {
    result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ ...options, cameraType: kind === 'selfie' ? ImagePicker.CameraType.front : ImagePicker.CameraType.back })
        : await ImagePicker.launchImageLibraryAsync(options);
  } catch {
    await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
    throw new PhotoError('The camera could not be opened on this device.');
  }
  await AsyncStorage.removeItem(PENDING_KEY).catch(() => {});
  if (result.canceled || !result.assets[0]) return false;

  await uploadAsset(role, kind, result.assets[0]);
  return true;
}

/**
 * Finishes a photo that was taken while Android had killed the app (the user
 * comes back to a fresh profile screen). Call once when the profile opens.
 * @returns true if a photo was recovered and uploaded.
 */
export async function recoverPendingPhoto(role: Role): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return false;
    const pending = JSON.parse(raw) as { role: Role; kind: PhotoKind };
    await AsyncStorage.removeItem(PENDING_KEY);
    if (pending.role !== role) return false;

    const pendingResult = await ImagePicker.getPendingResultAsync();
    if (!pendingResult || !('assets' in pendingResult) || pendingResult.canceled) return false;
    const asset = pendingResult.assets?.[0];
    if (!asset) return false;
    await uploadAsset(role, pending.kind, asset);
    return true;
  } catch {
    return false;
  }
}
