import { DuoFaceIdentityService } from './duoFaceIdentityService';
import type { AuthenticatedPrincipal } from '../types/auth';

/**
 * Resolves a verified Firebase identity to a Duo-Face role + merchant/driver
 * identity. As of docs/decisions/006-duo-face-identity-model.md, that
 * mapping lives in the Duo-Face-owned `duo_face_identities` Firestore
 * collection — never a Customer App collection.
 */
export interface RoleResolver {
  resolve(firebaseUid: string): Promise<AuthenticatedPrincipal | null>;
}

/**
 * Explicit-403 test double / fallback: always unresolved. Useful for tests
 * and for any context where no real resolver is configured. No longer the
 * production default — see DuoFaceRoleResolver.
 */
export class UnresolvedRoleResolver implements RoleResolver {
  async resolve(_firebaseUid: string): Promise<AuthenticatedPrincipal | null> {
    return null;
  }
}

/**
 * The real resolver: looks up the Duo-Face-owned identity document and maps
 * it to a principal. Never infers a role from anything else (email, phone,
 * display name) and never trusts client-supplied input — its only input is
 * the server-verified firebaseUid. A missing document, a suspended
 * identity, or a malformed document (caught from DuoFaceIdentityService,
 * which validates and throws rather than silently repairing) all resolve
 * to null — i.e. a 403 from resolveRole(), not a fabricated role.
 */
export class DuoFaceRoleResolver implements RoleResolver {
  constructor(private readonly identityService: DuoFaceIdentityService = new DuoFaceIdentityService()) {}

  async resolve(firebaseUid: string): Promise<AuthenticatedPrincipal | null> {
    let identity;
    try {
      identity = await this.identityService.getByFirebaseUid(firebaseUid);
    } catch (err) {
      console.error(
        'DuoFaceRoleResolver: identity lookup failed —',
        err instanceof Error ? err.message : 'unknown error'
      );
      return null;
    }

    if (!identity) return null;

    if (identity.status === 'suspended') {
      console.warn(`DuoFaceRoleResolver: identity ${firebaseUid} is suspended`);
      return null;
    }

    if (identity.role === 'merchant' && identity.merchant?.shopId) {
      return { firebaseUid, role: 'merchant', shopId: identity.merchant.shopId };
    }

    if (identity.role === 'driver' && identity.driver?.driverId) {
      return { firebaseUid, role: 'driver', driverId: identity.driver.driverId };
    }

    // Unreachable in practice — duoFaceIdentitySchema already rejects an
    // active merchant/driver missing its required id — but never fall
    // through to guessing a role if that invariant is ever loosened.
    return null;
  }
}
