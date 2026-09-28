import express from 'express';
import request from 'supertest';

import { requireRole } from '../../src/middleware/authorize';

describe('requireRole', () => {
  it('responds 501 for any role since role resolution is not implemented yet', async () => {
    const testApp = express();
    testApp.get('/protected', requireRole('merchant'), (_req, res) => res.json({ ok: true }));

    const response = await request(testApp).get('/protected');

    expect(response.status).toBe(501);
    expect(response.body.error).toBe('not_implemented');
  });
});
