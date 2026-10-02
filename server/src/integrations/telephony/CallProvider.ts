import { createHmac, timingSafeEqual } from 'crypto';

import { loadExotelCallConfig } from '../../config/telephony';
import type { ExotelCallConfig } from '../../config/telephony';
import { ExotelClient } from './ExotelClient';

/** Calling is not configured / the provider is down: surfaces as a 503, with no detail. */
export class CallingUnavailableError extends Error {
  constructor() {
    super('calling unavailable');
    this.name = 'CallingUnavailableError';
  }
}

export interface ConnectCallInput {
  driverPhone: string;
  customerPhone: string;
  /** Our own id for this call (also used to sign the status callback). */
  callId: string;
}

/**
 * Masked calling boundary (docs/decisions/028). The provider rings the driver
 * first, then connects the customer; each side sees only the company's
 * virtual number. Implementations must never log or return either number.
 */
export interface CallProvider {
  readonly enabled: boolean;
  connectCall(input: ConnectCallInput): Promise<{ providerCallSid: string }>;
}

export class UnconfiguredCallProvider implements CallProvider {
  readonly enabled = false;
  async connectCall(): Promise<{ providerCallSid: string }> {
    throw new CallingUnavailableError();
  }
}

/** Token that authenticates Exotel's status callback for one call (HMAC of the callId). */
export function signCallToken(secret: string, callId: string): string {
  return createHmac('sha256', secret).update(`call-status:${callId}`).digest('hex');
}

export function verifyCallToken(secret: string, callId: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(signCallToken(secret, callId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Hard cap on a bridged call (seconds): bounds cost if a call is left connected. */
export const MAX_CALL_SECONDS = 600;

export class ExotelCallProvider implements CallProvider {
  readonly enabled = true;

  constructor(
    private readonly config: ExotelCallConfig,
    private readonly client: ExotelClient = new ExotelClient(config)
  ) {}

  async connectCall({ driverPhone, customerPhone, callId }: ConnectCallInput): Promise<{ providerCallSid: string }> {
    const token = signCallToken(this.config.webhookSecret, callId);
    const baseUrl = this.config.publicBaseUrl.replace(/\/+$/, ''); // no double slash, whatever the config said
    const providerCallSid = await this.client.connectCall({
      from: driverPhone,
      to: customerPhone,
      callerId: this.config.callerId,
      statusCallback: `${baseUrl}/webhooks/exotel/call-status?callId=${encodeURIComponent(callId)}&t=${token}`,
      customField: callId,
      timeLimitSeconds: MAX_CALL_SECONDS,
    });
    return { providerCallSid };
  }
}

export function createCallProvider(source: NodeJS.ProcessEnv = process.env): CallProvider {
  const config = loadExotelCallConfig(source);
  return config ? new ExotelCallProvider(config) : new UnconfiguredCallProvider();
}
