import { createHash } from 'crypto';

import { loadCloudinaryConfig } from '../../config/cloudinary';
import type { CloudinaryConfig } from '../../config/cloudinary';

export const ALLOWED_FORMATS = 'jpg,jpeg,png,webp';

export interface UploadSignature {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  /** Sent as form fields exactly as given: they are part of the signature. */
  folder: string;
  allowedFormats: string;
}

export interface ImageHost {
  readonly enabled: boolean;
  signUpload(folder: string, now?: Date): UploadSignature;
  /** Public, resized delivery URL (Cloudinary picks the best format/quality per phone). */
  deliveryUrl(publicId: string, version: number): string;
  /** True when the image really exists on the host (a client-sent id is never trusted). */
  exists(url: string): Promise<boolean>;
  destroy(publicId: string): Promise<void>;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

/** Cloudinary signs the params sorted by name, joined with `&`, with the API secret appended. */
export function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return sha1(toSign + apiSecret);
}

export class CloudinaryImageHost implements ImageHost {
  constructor(private readonly config: CloudinaryConfig | null = loadCloudinaryConfig()) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  private need(): CloudinaryConfig {
    if (!this.config) throw new Error('Cloudinary is not configured');
    return this.config;
  }

  signUpload(folder: string, now: Date = new Date()): UploadSignature {
    const c = this.need();
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signParams({ allowed_formats: ALLOWED_FORMATS, folder, timestamp }, c.apiSecret);
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName}/image/upload`,
      apiKey: c.apiKey,
      timestamp,
      signature,
      folder,
      allowedFormats: ALLOWED_FORMATS,
    };
  }

  deliveryUrl(publicId: string, version: number): string {
    return `https://res.cloudinary.com/${this.need().cloudName}/image/upload/f_auto,q_auto,w_900,c_limit/v${version}/${publicId}`;
  }

  async exists(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async destroy(publicId: string): Promise<void> {
    const c = this.need();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({
      public_id: publicId,
      timestamp: String(timestamp),
      api_key: c.apiKey,
      signature: signParams({ public_id: publicId, timestamp }, c.apiSecret),
    });
    await fetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/image/destroy`, { method: 'POST', body });
  }
}

export const createImageHost = (): ImageHost => new CloudinaryImageHost();
