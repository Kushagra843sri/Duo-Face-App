import express from 'express';
import request from 'supertest';

import { requireRole } from '../../src/middleware/authorize';
import type { AuthenticatedRequest } from '../../src/types/auth';

function buildApp(principal: AuthenticatedRequest['principal']) {
  const app = express();
  app.get(
    '/protected',
    (req: AuthenticatedRequest, _res, next) => {
      req.principal = principal;
      next();
    },
    requireRole('merchant'),
    (_req, res) => res.json({ ok: true })
  );
  return app;
}

describe('requireRole', () => {
  it('calls next() when the principal has the required role', async () => {
    const response = await request(
      buildApp({ firebaseUid: 'uid', role: 'merchant', shopId: 'shop-1' })
    ).get('/protected');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects a principal with a different role', async () => {
    const response = await request(
      buildApp({ firebaseUid: 'uid', role: 'driver', driverId: 'driver-1' })
    ).get('/protected');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden');
  });

  it('rejects when no principal is present at all', async () => {
    const response = await request(buildApp(undefined)).get('/protected');
    expect(response.status).toBe(403);
  });
});
