import { randomUUID } from 'node:crypto';

import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { AppError } from '../middleware/errorHandler';
import type { AddressBody, AddressPatch, CustomerAddress } from '../types/customerOrder';

export const MAX_ADDRESSES = 10;

function toAddress(raw: Record<string, unknown>): CustomerAddress {
  return {
    addressId: String(raw.addressId),
    label: String(raw.label ?? ''),
    fullAddress: String(raw.fullAddress ?? ''),
    phoneNumber: String(raw.phoneNumber ?? ''),
    isDefault: raw.isDefault === true,
    ...(typeof raw.latitude === 'number' && typeof raw.longitude === 'number'
      ? { latitude: raw.latitude, longitude: raw.longitude }
      : {}),
  };
}

/** Address book at users/{uid}/addresses. The path itself is the ownership boundary: uid comes only from the verified token. */
export class CustomerAddressService {
  constructor(private readonly store: CustomerStore = new FirestoreCustomerStore()) {}

  async list(uid: string): Promise<CustomerAddress[]> {
    const rows = await this.store.listAddresses(uid);
    return rows.map(toAddress).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
  }

  async create(uid: string, body: AddressBody): Promise<CustomerAddress> {
    const existing = await this.store.listAddresses(uid);
    if (existing.length >= MAX_ADDRESSES) throw new AppError(409, `You can save at most ${MAX_ADDRESSES} addresses`);

    const addressId = randomUUID();
    const makeDefault = body.isDefault === true || existing.length === 0;
    if (makeDefault) await this.clearDefaults(uid, existing, addressId);

    const data: Record<string, unknown> = {
      label: body.label,
      fullAddress: body.fullAddress,
      phoneNumber: body.phoneNumber,
      isDefault: makeDefault,
      createdAt: new Date(),
      ...(body.latitude !== undefined ? { latitude: body.latitude, longitude: body.longitude } : {}),
    };
    await this.store.setAddress(uid, addressId, data);
    return toAddress({ ...data, addressId });
  }

  async update(uid: string, addressId: string, patch: AddressPatch): Promise<CustomerAddress> {
    const current = await this.store.getAddress(uid, addressId);
    if (!current) throw new AppError(404, 'Address not found');

    if (patch.isDefault === true) await this.clearDefaults(uid, await this.store.listAddresses(uid), addressId);
    // A default address cannot be un-defaulted directly; choose another default instead.
    const { isDefault, ...rest } = patch;
    const data: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (isDefault === true) data.isDefault = true;
    await this.store.setAddress(uid, addressId, data);
    return toAddress({ ...current, ...data });
  }

  async remove(uid: string, addressId: string): Promise<void> {
    const current = await this.store.getAddress(uid, addressId);
    if (!current) throw new AppError(404, 'Address not found');
    await this.store.deleteAddress(uid, addressId);

    if (current.isDefault === true) {
      const [next] = (await this.store.listAddresses(uid)).filter((a) => a.addressId !== addressId);
      if (next) await this.store.setAddress(uid, String(next.addressId), { isDefault: true });
    }
  }

  private async clearDefaults(uid: string, rows: Record<string, unknown>[], exceptId: string): Promise<void> {
    for (const row of rows) {
      if (row.isDefault === true && row.addressId !== exceptId) {
        await this.store.setAddress(uid, String(row.addressId), { isDefault: false });
      }
    }
  }
}
