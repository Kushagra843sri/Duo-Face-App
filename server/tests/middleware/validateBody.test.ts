import express from 'express';
import request from 'supertest';
import { z } from 'zod';

import { validateBody } from '../../src/middleware/validateBody';

const schema = z.object({ quantity: z.number().int().min(0) });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/items', validateBody(schema), (req, res) => res.json({ received: req.body }));
  return app;
}

describe('validateBody', () => {
  it('calls next() with the parsed body on valid input', async () => {
    const response = await request(buildApp()).post('/items').send({ quantity: 5 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: { quantity: 5 } });
  });

  it('returns 400 on invalid input', async () => {
    const response = await request(buildApp()).post('/items').send({ quantity: -1 });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('returns 400 when a required field is missing', async () => {
    const response = await request(buildApp()).post('/items').send({});
    expect(response.status).toBe(400);
  });
});
