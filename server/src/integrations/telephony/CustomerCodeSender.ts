import { loadExotelCallConfig, loadExotelSmsConfig } from '../../config/telephony';
import type { ExotelSmsConfig } from '../../config/telephony';
import { ExotelClient } from './ExotelClient';

export type CodeSendResult = 'sent' | 'failed' | 'disabled';

/**
 * Delivers the customer's delivery code (docs/decisions/028). The code is a
 * secret: implementations must never log it, the number, or the message.
 */
export interface CustomerCodeSender {
  readonly enabled: boolean;
  send(customerPhone: string, code: string): Promise<CodeSendResult>;
}

export class DisabledCustomerCodeSender implements CustomerCodeSender {
  readonly enabled = false;
  async send(): Promise<CodeSendResult> {
    return 'disabled';
  }
}

export class ExotelSmsCodeSender implements CustomerCodeSender {
  readonly enabled = true;

  constructor(
    private readonly sms: ExotelSmsConfig,
    private readonly client: ExotelClient
  ) {}

  async send(customerPhone: string, code: string): Promise<CodeSendResult> {
    try {
      await this.client.sendSms({
        from: this.sms.sender,
        to: customerPhone,
        body: this.sms.template.split('{code}').join(code),
        dltEntityId: this.sms.dltEntityId,
        dltTemplateId: this.sms.dltTemplateId,
      });
      return 'sent';
    } catch {
      return 'failed';
    }
  }
}

export function createCustomerCodeSender(source: NodeJS.ProcessEnv = process.env): CustomerCodeSender {
  const call = loadExotelCallConfig(source);
  const sms = loadExotelSmsConfig(source);
  // SMS needs the Exotel credentials; the call-specific fields (ExoPhone,
  // public URL) are not required for it, so read the credentials directly.
  const accountSid = source.EXOTEL_ACCOUNT_SID?.trim();
  const apiKey = source.EXOTEL_API_KEY?.trim();
  const apiToken = source.EXOTEL_API_TOKEN?.trim();
  if (!sms || !accountSid || !apiKey || !apiToken) return new DisabledCustomerCodeSender();
  return new ExotelSmsCodeSender(sms, new ExotelClient({ accountSid, apiKey, apiToken, host: call?.host ?? (source.EXOTEL_SUBDOMAIN?.trim() || 'api.in.exotel.com') }));
}
