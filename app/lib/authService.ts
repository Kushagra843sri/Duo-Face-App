import { onAuthStateChanged, RecaptchaVerifier, signInWithPhoneNumber } from 'firebase/auth';
import type { Auth, ConfirmationResult } from 'firebase/auth';
import { Platform } from 'react-native';

import { getFirebaseAuth } from '@/lib/firebase';
import { previewRole } from '@/lib/preview';

export interface PhoneSignInConfirmation {
  confirmCode(code: string): Promise<void>;
}

/** Deliberately minimal: no token, no role. The backend (/auth/me) is the only source of role. */
export interface AuthUser {
  uid: string;
  phoneNumber: string | null;
}

export interface AuthService {
  /** False when Firebase config is missing — auth then cannot succeed (nothing is faked). */
  readonly isConfigured: boolean;
  /** False where Firebase Phone OTP is not implemented (native, until a dev build is set up — docs/decisions/017). */
  readonly isPhoneSignInSupported: boolean;
  signInWithPhone(phoneNumber: string): Promise<PhoneSignInConfirmation>;
  getCurrentUser(): AuthUser | null;
  /** Fires once with the restored (or absent) session, then on every change. Returns an unsubscribe. */
  subscribe(listener: (user: AuthUser | null) => void): () => void;
  /** A current, SDK-refreshed Firebase ID token, or null when signed out. Never logged or persisted by the app. */
  getIdToken(): Promise<string | null>;
  signOut(): Promise<void>;
}

export class AuthNotConfiguredError extends Error {
  constructor(message = 'Firebase is not configured. Set the EXPO_PUBLIC_FIREBASE_* variables (see app/.env.example).') {
    super(message);
    this.name = 'AuthNotConfiguredError';
  }
}

export class PhoneSignInUnsupportedError extends Error {
  constructor() {
    super(
      'Phone sign-in is not available on this platform yet. Native Phone OTP needs a development build with native Firebase; use the web build for now.'
    );
    this.name = 'PhoneSignInUnsupportedError';
  }
}

function toAuthUser(user: { uid: string; phoneNumber: string | null }): AuthUser {
  return { uid: user.uid, phoneNumber: user.phoneNumber };
}

export class FirebaseAuthService implements AuthService {
  readonly isPhoneSignInSupported = Platform.OS === 'web';
  private verifier: RecaptchaVerifier | null = null;

  constructor(private readonly auth: Auth | null) {}

  get isConfigured() {
    return this.auth !== null;
  }

  private requireAuth(): Auth {
    if (!this.auth) throw new AuthNotConfiguredError();
    return this.auth;
  }

  async signInWithPhone(phoneNumber: string): Promise<PhoneSignInConfirmation> {
    const auth = this.requireAuth();
    if (!this.isPhoneSignInSupported) throw new PhoneSignInUnsupportedError();

    // Firebase requires a reCAPTCHA verifier for web phone auth. A fresh one
    // per attempt: a used verifier can't be reliably reused after an error.
    this.verifier?.clear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    this.verifier = new RecaptchaVerifier(auth, container, { size: 'invisible' });

    let confirmation: ConfirmationResult;
    try {
      confirmation = await signInWithPhoneNumber(auth, phoneNumber, this.verifier);
    } catch (error) {
      this.verifier.clear();
      this.verifier = null;
      throw error;
    }

    return {
      confirmCode: async (code: string) => {
        await confirmation.confirm(code);
      },
    };
  }

  getCurrentUser(): AuthUser | null {
    const user = this.auth?.currentUser;
    return user ? toAuthUser(user) : null;
  }

  subscribe(listener: (user: AuthUser | null) => void): () => void {
    if (!this.auth) {
      // Nothing to restore: report signed-out immediately.
      listener(null);
      return () => {};
    }
    return onAuthStateChanged(this.auth, (user) => listener(user ? toAuthUser(user) : null));
  }

  async getIdToken(): Promise<string | null> {
    // The background location task starts the JS app headless: wait until the
    // persisted session has been restored before concluding "signed out".
    await this.auth?.authStateReady();
    const user = this.auth?.currentUser;
    // getIdToken() returns the cached token and refreshes it when near
    // expiry — no custom refresh logic here.
    return user ? user.getIdToken() : null;
  }

  async signOut(): Promise<void> {
    if (!this.auth) return;
    // Stop this phone receiving the signed-out person's notifications (needs the session, so before signing out).
    try {
      const { unregisterFromPush } = await import('@/lib/push');
      await unregisterFromPush();
    } catch {
      // best effort
    }
    await this.auth.signOut();
  }
}

/**
 * Development UI preview only (lib/preview.ts): a stand-in "session" so the
 * screens can be viewed without Firebase. It authenticates nothing — the
 * token is never sent anywhere because api/client.ts serves sample data
 * instead of making requests. Unreachable in production builds.
 */
class PreviewAuthService implements AuthService {
  readonly isConfigured = true;
  readonly isPhoneSignInSupported = false;
  private readonly user: AuthUser = { uid: 'preview-user', phoneNumber: null };

  async signInWithPhone(): Promise<PhoneSignInConfirmation> {
    throw new Error('Sign-in is disabled in UI preview mode.');
  }
  getCurrentUser() {
    return this.user;
  }
  subscribe(listener: (user: AuthUser | null) => void) {
    listener(this.user);
    return () => {};
  }
  async getIdToken() {
    return 'preview-not-a-real-token';
  }
  async signOut() {}
}

export const authService: AuthService = previewRole ? new PreviewAuthService() : new FirebaseAuthService(getFirebaseAuth());
