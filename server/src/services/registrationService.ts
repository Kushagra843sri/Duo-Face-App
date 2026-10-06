import { randomUUID } from 'crypto';

import { z } from 'zod';

import { AppError } from '../middleware/errorHandler';
import { DriverProvisioningService } from './driverProvisioningService';
import { DuoFaceIdentityService } from './duoFaceIdentityService';
import { MerchantProvisioningService } from './merchantProvisioningService';
import type { Role } from '../types/auth';

/**
 * `.strict()`: the body carries only the registration intent and display
 * names. A client-sent uid, shopId, driverId or status is a 400 — identity
 * comes from the verified token and every id is generated here.
 */
export const registerBodySchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('driver'), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ intent: z.literal('merchant'), shopName: z.string().trim().min(1).max(100) }).strict(),
]);

export type RegisterBody = z.infer<typeof registerBodySchema>;

export interface RegistrationResult {
  role: Role;
}

/**
 * Self-registration (docs/decisions/030). The role is the caller's intent
 * only at creation time: it is recorded server-side in duo_face_identities
 * and every later request resolves it from there. Create-only — an identity
 * that already exists is never changed or switched.
 */
export class RegistrationService {
  constructor(
    private readonly identities: DuoFaceIdentityService = new DuoFaceIdentityService(),
    private readonly drivers: DriverProvisioningService = new DriverProvisioningService(),
    private readonly merchants: MerchantProvisioningService = new MerchantProvisioningService()
  ) {}

  async register(firebaseUid: string, body: RegisterBody): Promise<RegistrationResult> {
    if (await this.identities.getByFirebaseUid(firebaseUid)) {
      throw new AppError(409, 'This account is already registered.');
    }

    if (body.intent === 'driver') {
      await this.drivers.provisionDriver({ firebaseUid, name: body.name });
    } else {
      await this.merchants.provisionMerchantShop({
        firebaseUid,
        shopId: randomUUID(),
        name: body.shopName,
        listForCustomers: true,
      });
    }
    return { role: body.intent };
  }
}
