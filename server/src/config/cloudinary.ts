import { z } from 'zod';

const schema = z.object({
  CLOUDINARY_CLOUD_NAME: z.string().trim().min(1),
  CLOUDINARY_API_KEY: z.string().trim().min(1),
  CLOUDINARY_API_SECRET: z.string().trim().min(1),
});

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Null when Cloudinary is not configured: shop-photo endpoints answer 503, everything else works. */
export function loadCloudinaryConfig(source: NodeJS.ProcessEnv = process.env): CloudinaryConfig | null {
  const parsed = schema.safeParse({
    CLOUDINARY_CLOUD_NAME: source.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: source.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: source.CLOUDINARY_API_SECRET,
  });
  if (!parsed.success) return null;
  return { cloudName: parsed.data.CLOUDINARY_CLOUD_NAME, apiKey: parsed.data.CLOUDINARY_API_KEY, apiSecret: parsed.data.CLOUDINARY_API_SECRET };
}
