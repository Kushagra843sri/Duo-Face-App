import express from 'express';
import request from 'supertest';

import { resolveRole } from '../../src/middleware/resolveRole';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { AuthenticatedPrincipal, AuthenticatedRequest } from '../../src/types/auth';

function buildApp(roleResolver: RoleResolver, options: { withIdentity?: boolean } = {}) {
  const app = express();

  app.get(
    '/protected',
    (req: AuthenticatedRequest, _res, next) => {
      if (options.withIdentity !== false) {
        req.identity = { firebaseUid: 'test-uid' };
      }
      next();
    },
    resolveRole(roleResolver),
    (req: AuthenticatedRequest, res) => {
      res.json({ principal: req.principal });
    }
  );

  return app;
}

const unresolvedResolver: RoleResolver = {
  resolve: async () => null,
};

const mockPrincipal: AuthenticatedPrincipal = {
  firebaseUid: 'test-uid',
  role: 'merchant',
  shopId: 'shop-1',
};

const resolvingResolver: RoleResolver = {
  resolve: async () => mockPrincipal,
};

describe('resolveRole', () => {
  it('returns 401 if no verified identity is present (must run after authenticateFirebase)', async () => {
    const response = await request(buildApp(unresolvedResolver, { withIdentity: false })).get('/protected');
    expect(response.status).toBe(401);
  });

  it('returns 403 when the resolver finds no role mapping', async () => {
    const response = await request(buildApp(unresolvedResolver)).get('/protected');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('role_unresolved');
  });

  it('attaches exactly the resolved principal and calls next() when a role is mapped', async () => {
    const response = await request(buildApp(resolvingResolver)).get('/protected');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ principal: mockPrincipal });
  });
});
