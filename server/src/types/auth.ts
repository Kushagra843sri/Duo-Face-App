export type Role = 'merchant' | 'driver';

export interface AuthenticatedPrincipal {
  userId: string;
  role: Role;
  storeId?: string; // present when role === 'merchant'
  driverId?: string; // present when role === 'driver'
}
