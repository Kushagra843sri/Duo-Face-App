import express from 'express';
import request from 'supertest';

import { authenticateFirebase } from '../../src/middleware/authenticate';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { AuthenticatedRequest } from '../../src/types/auth';

function buildApp(verifier: FirebaseIdentityVerifier) {
  const app = express();
  app.use(express.json());
  app.get('/protected', authenticateFirebase(verifier), (req: AuthenticatedRequest, res) => {
    res.json({ identity: req.identity });
  });
  return app;
}

const okVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => ({ firebaseUid: 'test-uid' }),
};

const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};

describe('authenticateFirebase', () => {
  it('rejects a missing Authorization header', async () => {
    const response = await request(buildApp(okVerifier)).get('/protected');
    expect(response.status).toBe(401);
  });

  it('rejects a malformed Authorization header', async () => {
    const response = await request(buildApp(okVerifier))
      .get('/protected')
      .set('Authorization', 'Basic sometoken');
    expect(response.status).toBe(401);
  });

  it('rejects an invalid Firebase token', async () => {
    const response = await request(buildApp(failingVerifier))
      .get('/protected')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('accepts a valid Firebase token and attaches only the verified identity', async () => {
    const response = await request(buildApp(okVerifier))
      .get('/protected')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ identity: { firebaseUid: 'test-uid' } });
  });
});
