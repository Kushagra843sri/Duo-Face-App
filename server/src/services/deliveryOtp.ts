import { createHmac, randomInt, timingSafeEqual } from 'crypto';

/** Wrong guesses allowed per assignment before the code is locked (CLAUDE.md). */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Delivery code helpers (docs/decisions/028). The plaintext exists only in
 * memory at generation time (to be sent to the customer); storage holds an
 * HMAC bound to the assignment, so the same digits hash differently for every
 * delivery and a leaked document does not reveal the code.
 */
export class DeliveryOtp {
  constructor(private readonly secret: string) {}

  /** Uniformly random 6 digits (CSPRNG). */
  generate(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  hash(assignmentId: string, code: string): string {
    return createHmac('sha256', this.secret).update(`delivery-otp:${assignmentId}:${code}`).digest('hex');
  }

  /** Constant-time comparison. */
  verify(assignmentId: string, code: string, expectedHash: string): boolean {
    const given = Buffer.from(this.hash(assignmentId, code));
    const expected = Buffer.from(expectedHash);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
