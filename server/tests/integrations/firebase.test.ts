import { getFirebaseAdminApp } from '../../src/integrations/firebase/firebaseAdmin';
import { FirebaseAuthService } from '../../src/integrations/firebase/FirebaseAuthService';

describe('getFirebaseAdminApp', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws a clear, specific error when no Firebase configuration is present', () => {
    expect(() => getFirebaseAdminApp()).toThrow(/FIREBASE_PROJECT_ID/);
  });
});

describe('FirebaseAuthService.verifyIdToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('propagates a clear failure instead of inventing an identity when unconfigured', async () => {
    const service = new FirebaseAuthService();
    await expect(service.verifyIdToken('any-token')).rejects.toThrow(/FIREBASE_PROJECT_ID/);
  });
});
