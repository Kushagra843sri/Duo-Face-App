import { z } from 'zod';

const redisEnvSchema = z.object({
  REDIS_URL: z
    .string()
    .trim()
    .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://'),
});

/**
 * null when Redis is not configured (or the URL is malformed): live
 * tracking then answers 503 — the server itself keeps running and nothing
 * silently falls back to Firestore.
 */
export function loadRedisUrl(source: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = redisEnvSchema.safeParse({ REDIS_URL: source.REDIS_URL });
  return parsed.success ? parsed.data.REDIS_URL : null;
}
