import type { VerifiedFirebaseIdentity } from '../../types/auth';
import { getFirebaseAdminApp } from './firebaseAdmin';

/**
 * DI seam: authenticateFirebase() depends on this interface, not the concrete
 * class, so tests can inject a mock instead of touching real firebase-admin
 * or requiring a live Firebase project.
 */
export interface FirebaseIdentityVerifier {
  verifyIdToken(token: string): Promise<VerifiedFirebaseIdentity>;
}

export class FirebaseAuthService implements FirebaseIdentityVerifier {
  async verifyIdToken(token: string): Promise<VerifiedFirebaseIdentity> {
    // Deferred until actually called: getFirebaseAdminApp() throws first when
    // unconfigured, and merely importing this class must not eagerly pull in
    // firebase-admin/auth's dependency chain (which ships an ESM-only
    // transitive dependency plain Node handles natively, but Jest's own
    // module loader does not).
    const app = getFirebaseAdminApp();
    const { getAuth } = await import('firebase-admin/auth');
    const decoded = await getAuth(app).verifyIdToken(token);
    return { firebaseUid: decoded.uid };
  }
}
