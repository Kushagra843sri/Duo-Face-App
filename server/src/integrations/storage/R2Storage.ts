import { createHash, createHmac } from 'crypto';

import { loadR2Config } from '../../config/profile';
import type { R2Config } from '../../config/profile';

/** Storage not configured / unreachable. No detail: never carries a URL, key or credential. */
export class StorageUnavailableError extends Error {
  constructor() {
    super('storage unavailable');
    this.name = 'StorageUnavailableError';
  }
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
}

/**
 * Private object storage for profile / KYC photos. Callers store only the
 * object KEY; signed URLs are generated per request, are short-lived, and must
 * never be logged or persisted (CLAUDE.md: never log or return raw document URLs).
 */
export interface ObjectStorage {
  readonly enabled: boolean;
  presignPut(input: { key: string; contentType: string; contentLength: number; expiresSeconds: number }): string;
  presignGet(key: string, expiresSeconds: number): string;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
}

export class UnconfiguredObjectStorage implements ObjectStorage {
  readonly enabled = false;
  presignPut(): string {
    throw new StorageUnavailableError();
  }
  presignGet(): string {
    throw new StorageUnavailableError();
  }
  async head(): Promise<ObjectHead | null> {
    throw new StorageUnavailableError();
  }
  async delete(): Promise<void> {
    throw new StorageUnavailableError();
  }
}

const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeRfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  host: string;
  /** Absolute path, already the path the server will see (e.g. /bucket/key). Encoded per segment here. */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Formatted as YYYYMMDDTHHMMSSZ. */
  amzDate: string;
  expiresSeconds: number;
  /** Extra headers that become part of the signature (the client must send them exactly). */
  signedHeaders?: Record<string, string>;
}

/**
 * AWS Signature V4 query-string presigning (S3 / R2 compatible), UNSIGNED-PAYLOAD.
 * Pure and deterministic so it can be checked against AWS's published example.
 */
export function presignUrl(input: PresignInput): string {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;

  const headers: Record<string, string> = { host: input.host, ...Object.fromEntries(Object.entries(input.signedHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])) };
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaderList = headerNames.join(';');

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', input.amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaderList],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalPath = input.path
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
  const canonicalRequest = [input.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaderList, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const toAmzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

type FetchLike = (url: string, init: { method: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null } }>;

/** Cloudflare R2 over its S3-compatible API (path-style, region "auto"). */
export class R2ObjectStorage implements ObjectStorage {
  readonly enabled = true;
  private readonly host: string;

  constructor(
    private readonly config: R2Config,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {
    this.host = `${config.accountId}.r2.cloudflarestorage.com`;
  }

  private sign(method: PresignInput['method'], key: string, expiresSeconds: number, signedHeaders?: Record<string, string>): string {
    return presignUrl({
      method,
      host: this.host,
      path: `/${this.config.bucket}/${key}`,
      region: 'auto',
      service: 's3',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      amzDate: toAmzDate(this.now()),
      expiresSeconds,
      signedHeaders,
    });
  }

  presignPut({ key, contentType, contentLength, expiresSeconds }: { key: string; contentType: string; contentLength: number; expiresSeconds: number }): string {
    return this.sign('PUT', key, expiresSeconds, { 'content-type': contentType, 'content-length': String(contentLength) });
  }

  presignGet(key: string, expiresSeconds: number): string {
    return this.sign('GET', key, expiresSeconds);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.fetchImpl(this.sign('HEAD', key, 60), { method: 'HEAD' });
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageUnavailableError();
      return { size: Number(response.headers.get('content-length') ?? 0), contentType: response.headers.get('content-type') };
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw err;
      throw new StorageUnavailableError();
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const response = await this.fetchImpl(this.sign('DELETE', key, 60), { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new StorageUnavailableError();
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw err;
      throw new StorageUnavailableError();
    }
  }
}

export function createObjectStorage(source: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const config = loadR2Config(source);
  return config ? new R2ObjectStorage(config) : new UnconfiguredObjectStorage();
}
