import type { ExotelCallConfig } from '../../config/telephony';

/** One non-leaky failure: carries a category only — never numbers, URLs, credentials or provider bodies. */
export class TelephonyError extends Error {
  constructor(readonly category: 'timeout' | 'rejected' | 'unavailable' | 'invalid_number') {
    super(`telephony ${category}`);
    this.name = 'TelephonyError';
  }
}

/** Indian mobile/landline in E.164 (+91...) or any E.164 number; rejects anything else before it reaches Exotel. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Thin Exotel REST client (https://developer.exotel.com). HTTP Basic auth with
 * the API key/token, form-encoded bodies. The fetch implementation is
 * injectable for tests. Phone numbers are passed through to Exotel and are
 * never logged or put in errors.
 */
export class ExotelClient {
  constructor(
    private readonly config: Pick<ExotelCallConfig, 'accountSid' | 'apiKey' | 'apiToken' | 'host'>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 10_000
  ) {}

  private async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://${this.config.host}/v1/Accounts/${encodeURIComponent(this.config.accountSid)}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.apiKey}:${this.config.apiToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      });
      if (!response.ok) throw new TelephonyError(response.status >= 500 ? 'unavailable' : 'rejected');
      return ((await response.json()) ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof TelephonyError) throw err;
      throw new TelephonyError((err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  /** "Connect two numbers": rings `from` first, then connects `to`. Returns Exotel's call Sid. */
  async connectCall(input: { from: string; to: string; callerId: string; statusCallback: string; customField: string; timeLimitSeconds: number }): Promise<string> {
    if (!isE164(input.from) || !isE164(input.to)) throw new TelephonyError('invalid_number');
    const body = await this.post('/Calls/connect', {
      From: input.from,
      To: input.to,
      CallerId: input.callerId,
      StatusCallback: input.statusCallback,
      'StatusCallbackEvents[0]': 'terminal',
      CustomField: input.customField,
      TimeLimit: String(input.timeLimitSeconds),
      Record: 'false',
    });
    const sid = (body.Call as { Sid?: unknown } | undefined)?.Sid;
    if (typeof sid !== 'string' || sid.length === 0) throw new TelephonyError('rejected');
    return sid;
  }

  /** DLT-compliant transactional SMS (India). */
  async sendSms(input: { from: string; to: string; body: string; dltEntityId: string; dltTemplateId: string }): Promise<void> {
    if (!isE164(input.to)) throw new TelephonyError('invalid_number');
    await this.post('/Sms/send', {
      From: input.from,
      To: input.to,
      Body: input.body,
      DltEntityId: input.dltEntityId,
      DltTemplateId: input.dltTemplateId,
      Priority: 'high',
    });
  }
}
