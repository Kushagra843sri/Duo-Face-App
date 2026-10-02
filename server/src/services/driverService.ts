import { FirestoreDuoFaceDriverStore } from '../integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceDriverStore } from '../integrations/firebase/FirestoreDuoFaceDriverStore';
import { duoFaceDriverSchema } from '../types/duoFaceDriver';
import type { DuoFaceDriver } from '../types/duoFaceDriver';

export interface CreateDriverInput {
  driverId: string;
  firebaseUid: string;
  name: string;
  phoneNumber?: string;
}

export class DriverService {
  constructor(private readonly store: DuoFaceDriverStore = new FirestoreDuoFaceDriverStore()) {}

  /**
   * Throws (never silently repairs) on a malformed stored document — an
   * unsupported status, a missing field, or a driverId field that doesn't
   * match the document it was read from.
   */
  async getById(driverId: string): Promise<DuoFaceDriver | null> {
    const raw = await this.store.get(driverId);
    if (!raw) return null;

    const driver = duoFaceDriverSchema.parse(raw);
    if (driver.driverId !== driverId) {
      throw new Error(`duo_face_drivers/${driverId} has a mismatched driverId field`);
    }

    return driver;
  }

  /**
   * Malformed documents are skipped and logged � one bad profile must not
   * break a merchant's whole driver list. Driver profiles are global
   * Duo-Face identities (not shop-owned), so this takes no shop argument.
   * Sorted by name in application code.
   */
  async listActiveDrivers(): Promise<DuoFaceDriver[]> {
    const raw = await this.store.listByStatus('active');
    const drivers: DuoFaceDriver[] = [];
    for (const doc of raw) {
      const parsed = duoFaceDriverSchema.safeParse(doc);
      if (!parsed.success) {
        console.warn('DriverService: skipping malformed driver profile', parsed.error.issues);
        continue;
      }
      // Defense in depth: never trust the query filter alone.
      if (parsed.data.status !== 'active') continue;
      drivers.push(parsed.data);
    }
    drivers.sort((a, b) => a.name.localeCompare(b.name));
    return drivers;
  }

  async getByFirebaseUid(firebaseUid: string): Promise<DuoFaceDriver | null> {
    const raw = await this.store.findByFirebaseUid(firebaseUid);
    if (!raw) return null;

    const driver = duoFaceDriverSchema.parse(raw);
    if (driver.firebaseUid !== firebaseUid) {
      throw new Error(`duo_face_drivers query for firebaseUid ${firebaseUid} returned a mismatched document`);
    }

    return driver;
  }

  /**
   * Direct, single-collection write — used internally by
   * DriverProvisioningService's atomic transaction path, and available on
   * its own. Overwrites whatever exists at driverId; rejecting a genuine
   * duplicate is DriverProvisioningService's job (it checks first), not
   * this method's.
   */
  async createDriver(input: CreateDriverInput): Promise<DuoFaceDriver> {
    const now = new Date();
    const data: Record<string, unknown> = {
      driverId: input.driverId,
      firebaseUid: input.firebaseUid,
      name: input.name,
      ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.store.set(input.driverId, data);
    return duoFaceDriverSchema.parse(data);
  }

  /**
   * Changes only onDuty / dutyChangedAt / updatedAt. Throws if the driver
   * does not exist. Callers enforce the "no active delivery" rule
   * (DriverDutyService); this is the plain write.
   */
  async setDuty(driverId: string, onDuty: boolean): Promise<DuoFaceDriver> {
    const existing = await this.getById(driverId);
    if (!existing) {
      throw new Error(`Cannot set duty on duo_face_drivers/${driverId}: no such driver exists`);
    }

    const now = new Date();
    const data: Record<string, unknown> = { ...existing, onDuty, dutyChangedAt: now, updatedAt: now };
    await this.store.set(driverId, data);
    return duoFaceDriverSchema.parse(data);
  }

  /**
   * Updates the display name / contact number kept on the driver document
   * (merchants see the name; the masked call rings the number). Only these
   * two fields change. Throws if the driver does not exist.
   */
  async updateContact(driverId: string, patch: { name?: string; phoneNumber?: string }): Promise<DuoFaceDriver> {
    const existing = await this.getById(driverId);
    if (!existing) {
      throw new Error(`Cannot update duo_face_drivers/${driverId}: no such driver exists`);
    }

    const data: Record<string, unknown> = {
      ...existing,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.phoneNumber ? { phoneNumber: patch.phoneNumber } : {}),
      updatedAt: new Date(),
    };
    await this.store.set(driverId, data);
    return duoFaceDriverSchema.parse(data);
  }

  /**
   * Throws if the driver doesn't exist — suspending a nonexistent driver is
   * an error, not a silent no-op.
   */
  async suspendDriver(driverId: string): Promise<DuoFaceDriver> {
    const existing = await this.getById(driverId);
    if (!existing) {
      throw new Error(`Cannot suspend duo_face_drivers/${driverId}: no such driver exists`);
    }

    const data: Record<string, unknown> = {
      ...existing,
      status: 'suspended',
      updatedAt: new Date(),
    };

    await this.store.set(driverId, data);
    return duoFaceDriverSchema.parse(data);
  }
}
