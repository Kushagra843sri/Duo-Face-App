// Client-side boundary for Firebase Phone Auth. No concrete implementation
// yet — no Expo Firebase configuration exists because no Firebase project
// exists yet (see docs/decisions/002-customer-app-integration.md).
// Implementing this against a fake/mocked Firebase client would be exactly
// the kind of invented behavior this phase avoids.

export interface PhoneSignInConfirmation {
  confirmCode(code: string): Promise<void>;
}

export interface AuthService {
  signInWithPhone(phoneNumber: string): Promise<PhoneSignInConfirmation>;
  getIdToken(): Promise<string | null>;
  signOut(): Promise<void>;
}

export class UnconfiguredAuthService implements AuthService {
  async signInWithPhone(): Promise<PhoneSignInConfirmation> {
    throw new Error('Firebase Phone Auth is not configured yet.');
  }

  async getIdToken(): Promise<string | null> {
    return null;
  }

  async signOut(): Promise<void> {}
}

export const authService: AuthService = new UnconfiguredAuthService();
