import { randomUUID } from 'crypto';

import { StorageUnavailableError } from '../integrations/storage/R2Storage';
import type { ObjectStorage } from '../integrations/storage/R2Storage';
import { AppError } from '../middleware/errorHandler';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../types/profile';

/** Short-lived on purpose: long enough to upload / view, too short to be shared around. */
export const SIGNED_URL_SECONDS = 300;

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Implemented by the profile services: where the photo KEY (never a URL) is recorded. */
export interface PhotoTarget {
  getPhotoKey(ownerId: string, kind: string): Promise<string | null>;
  setPhotoKey(ownerId: string, kind: string, key: string | null): Promise<void>;
}

export interface UploadGrant {
  uploadUrl: string;
  objectKey: string;
  /** The client must send exactly these headers (they are part of the signature). */
  headers: Record<string, string>;
  expiresInSeconds: number;
}

/**
 * Direct-to-bucket photo upload with pre-signed URLs (docs/decisions/029):
 * 1. requestUpload: the server picks the object key (never the client) and
 *    signs a PUT bound to the content type and exact byte length.
 * 2. the phone uploads straight to the private bucket.
 * 3. confirm: the server checks the object really exists with an allowed
 *    type/size under the caller's own prefix, then records the KEY.
 * Signed URLs are returned to the caller only and are never logged or stored.
 */
export class ProfilePhotoService {
  constructor(
    private readonly role: 'driver' | 'merchant',
    private readonly storage: ObjectStorage,
    private readonly target: PhotoTarget
  ) {}

  private prefix(ownerId: string, kind: string) {
    return `${this.role}/${ownerId}/${kind}/`;
  }

  private requireStorage() {
    if (!this.storage.enabled) throw new AppError(503, 'Photo upload is not configured.');
  }

  async requestUpload(ownerId: string, kind: string, contentType: string, sizeBytes: number): Promise<UploadGrant> {
    this.requireStorage();
    if (!(PHOTO_CONTENT_TYPES as readonly string[]).includes(contentType) || sizeBytes < 1 || sizeBytes > MAX_PHOTO_BYTES) {
      throw new AppError(400, 'Photos must be JPEG, PNG or WebP and at most 5 MB.');
    }
    const objectKey = `${this.prefix(ownerId, kind)}${randomUUID()}.${EXTENSION[contentType]}`;
    try {
      const uploadUrl = this.storage.presignPut({ key: objectKey, contentType, contentLength: sizeBytes, expiresSeconds: SIGNED_URL_SECONDS });
      return { uploadUrl, objectKey, headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) }, expiresInSeconds: SIGNED_URL_SECONDS };
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw new AppError(503, 'Photo upload is not available right now.');
      throw err;
    }
  }

  async confirm(ownerId: string, kind: string, objectKey: string): Promise<void> {
    this.requireStorage();
    // The key must be one WE issued for THIS owner and kind: nobody can attach another person's object.
    if (!objectKey.startsWith(this.prefix(ownerId, kind)) || objectKey.includes('..')) {
      throw new AppError(400, 'Invalid upload.');
    }
    try {
      const head = await this.storage.head(objectKey);
      if (!head) throw new AppError(409, 'Upload not found. Please try again.');
      const type = (head.contentType ?? '').toLowerCase();
      if (head.size < 1 || head.size > MAX_PHOTO_BYTES || !(PHOTO_CONTENT_TYPES as readonly string[]).includes(type)) {
        await this.storage.delete(objectKey).catch(() => {});
        throw new AppError(409, 'That file is not an allowed photo.');
      }
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw new AppError(503, 'Photo upload is not available right now.');
      throw err;
    }

    const previous = await this.target.getPhotoKey(ownerId, kind);
    await this.target.setPhotoKey(ownerId, kind, objectKey);
    if (previous && previous !== objectKey) await this.storage.delete(previous).catch(() => {}); // best effort
  }

  async remove(ownerId: string, kind: string): Promise<void> {
    const previous = await this.target.getPhotoKey(ownerId, kind);
    if (!previous) return;
    await this.target.setPhotoKey(ownerId, kind, null);
    if (this.storage.enabled) await this.storage.delete(previous).catch(() => {});
  }

  /** A short-lived view URL for a stored key, or null. Never logged, never persisted. */
  viewUrl(key: string | null | undefined): string | null {
    if (!key || !this.storage.enabled) return null;
    try {
      return this.storage.presignGet(key, SIGNED_URL_SECONDS);
    } catch {
      return null;
    }
  }
}
