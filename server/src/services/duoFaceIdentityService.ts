import { z } from 'zod';

import { FirestoreDuoFaceIdentityStore } from '../integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceIdentityStore } from '../integrations/firebase/FirestoreDuoFaceIdentityStore';
import { duoFaceIdentitySchema } from '../types/duoFaceIdentity';
import type { DuoFaceIdentity } from '../types/duoFaceIdentity';

const provisionMerchantInputSchema = z.object({
  firebaseUid: z.string().min(1),
  role: z.literal('merchant'),
  shopId: z.string().min(1),
});

const provisionDriverInputSchema = z.object({
  firebaseUid: z.string().min(1),
  role: z.literal('driver'),
  driverId: z.string().min(1),
});

const provisionIdentityInputSchema = z.discriminatedUnion('role', [
  provisionMerchantInputSchema,
  provisionDriverInputSchema,
]);

export type ProvisionIdentityInput = z.infer<typeof provisionIdentityInputSchema>;

export class DuoFaceIdentityService {
  constructor(private readonly store: DuoFaceIdentityStore = new FirestoreDuoFaceIdentityStore()) {}

  /**
   * Throws (never silently repairs) if the stored document is malformed —
   * an unsupported role, a status outside active/suspended, a merchant
   * without shopId, a driver without driverId, both mappings present, or a
   * firebaseUid field that doesn't match the document it was read from.
   */
  async getByFirebaseUid(firebaseUid: string): Promise<DuoFaceIdentity | null> {
    const raw = await this.store.get(firebaseUid);
    if (!raw) return null;

    const identity = duoFaceIdentitySchema.parse(raw);

    if (identity.firebaseUid !== firebaseUid) {
      throw new Error(`duo_face_identities/${firebaseUid} has a mismatched firebaseUid field`);
    }

    return identity;
  }

  /**
   * Internal provisioning operation — not called from any route in this
   * phase. No self-service role escalation exists; a future phase designs
   * the authenticated admin/ops mechanism that would call this.
   */
  async provisionIdentity(input: ProvisionIdentityInput): Promise<DuoFaceIdentity> {
    const parsed = provisionIdentityInputSchema.parse(input);
    const now = new Date();

    const data: Record<string, unknown> = {
      firebaseUid: parsed.firebaseUid,
      role: parsed.role,
      status: 'active',
      ...(parsed.role === 'merchant' ? { merchant: { shopId: parsed.shopId } } : { driver: { driverId: parsed.driverId } }),
      createdAt: now,
      updatedAt: now,
    };

    await this.store.set(parsed.firebaseUid, data);
    return duoFaceIdentitySchema.parse(data);
  }
}
