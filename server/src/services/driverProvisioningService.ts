import { randomUUID } from 'crypto';

import { z } from 'zod';

import { getFirebaseAdminApp } from '../integrations/firebase/firebaseAdmin';
import { DriverService } from './driverService';
import { DuoFaceIdentityService } from './duoFaceIdentityService';
import { duoFaceDriverSchema } from '../types/duoFaceDriver';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import { duoFaceIdentitySchema } from '../types/duoFaceIdentity';
import type { DuoFaceIdentity } from '../types/duoFaceIdentity';

const provisionDriverInputSchema = z.object({
  firebaseUid: z.string().min(1),
  name: z.string().min(1),
  phoneNumber: z.string().min(1).optional(),
});

export type ProvisionDriverInput = z.infer<typeof provisionDriverInputSchema>;

interface AtomicWrite {
  identityFirebaseUid: string;
  identityData: Record<string, unknown>;
  driverId: string;
  driverData: Record<string, unknown>;
}

/**
 * Narrow, purpose-built transactional seam — mirrors
 * DuoFaceProvisioningTransaction in merchantProvisioningService.ts. Real
 * implementation runs one Firestore transaction writing both documents so
 * the identity/driver relationship can never be partially created.
 */
export interface DriverProvisioningTransaction {
  runAtomic(write: AtomicWrite): Promise<void>;
}

export class FirestoreDriverProvisioningTransaction implements DriverProvisioningTransaction {
  async runAtomic({ identityFirebaseUid, identityData, driverId, driverData }: AtomicWrite): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());

    await db.runTransaction(async (tx) => {
      tx.set(db.collection('duo_face_identities').doc(identityFirebaseUid), identityData);
      tx.set(db.collection('duo_face_drivers').doc(driverId), driverData);
    });
  }
}

export interface ProvisionDriverResult {
  identity: DuoFaceIdentity;
  driver: DuoFaceDriver;
}

export class DriverProvisioningService {
  constructor(
    private readonly identityService: DuoFaceIdentityService = new DuoFaceIdentityService(),
    private readonly driverService: DriverService = new DriverService(),
    private readonly transaction: DriverProvisioningTransaction = new FirestoreDriverProvisioningTransaction()
  ) {}

  /**
   * Not called from any route — a domain operation only (see
   * docs/decisions/013-driver-and-delivery-assignment.md). No
   * self-registration, no client-selected role, no "Become a Driver"
   * endpoint. Create-only: rejects rather than repairs any pre-existing,
   * inconsistent state.
   */
  async provisionDriver(input: ProvisionDriverInput): Promise<ProvisionDriverResult> {
    const parsed = provisionDriverInputSchema.parse(input);

    const existingIdentity = await this.identityService.getByFirebaseUid(parsed.firebaseUid);
    if (existingIdentity) {
      throw new Error(`Cannot provision: an identity already exists for firebaseUid ${parsed.firebaseUid}`);
    }

    const existingDriverForUid = await this.driverService.getByFirebaseUid(parsed.firebaseUid);
    if (existingDriverForUid) {
      throw new Error(
        `Cannot provision: driver ${existingDriverForUid.driverId} already references firebaseUid ${parsed.firebaseUid} with no matching identity`
      );
    }

    const driverId = randomUUID();
    const now = new Date();

    const identityData: Record<string, unknown> = {
      firebaseUid: parsed.firebaseUid,
      role: 'driver',
      status: 'active',
      driver: { driverId },
      createdAt: now,
      updatedAt: now,
    };

    const driverData: Record<string, unknown> = {
      driverId,
      firebaseUid: parsed.firebaseUid,
      name: parsed.name,
      ...(parsed.phoneNumber ? { phoneNumber: parsed.phoneNumber } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.transaction.runAtomic({
      identityFirebaseUid: parsed.firebaseUid,
      identityData,
      driverId,
      driverData,
    });

    return {
      identity: duoFaceIdentitySchema.parse(identityData),
      driver: duoFaceDriverSchema.parse(driverData),
    };
  }
}
