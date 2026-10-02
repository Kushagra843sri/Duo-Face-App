import type { Request } from 'express';

import type { DuoFaceDriver } from './duoFaceDriver';
import type { DuoFaceShop } from './duoFaceShop';

export type Role = 'merchant' | 'driver';

/** Everything Firebase ID-token verification alone guarantees. Nothing about role. */
export interface VerifiedFirebaseIdentity {
  firebaseUid: string;
}

/** Produced by role resolution from a VerifiedFirebaseIdentity — see server/src/services/roleResolver.ts. */
export interface AuthenticatedPrincipal {
  firebaseUid: string;
  role: Role;
  shopId?: string; // present when role === 'merchant' — matches the Customer App's real `shops` collection name
  driverId?: string; // present when role === 'driver'
}

export interface AuthenticatedRequest extends Request {
  identity?: VerifiedFirebaseIdentity;
  principal?: AuthenticatedPrincipal;
  shop?: DuoFaceShop; // attached by middleware/requireActiveMerchantShop.ts
  driver?: DuoFaceDriver; // attached by middleware/requireActiveDriver.ts
}
