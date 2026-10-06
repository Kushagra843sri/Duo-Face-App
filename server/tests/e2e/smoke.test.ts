import './helpers/env';

import request from 'supertest';

import { app } from '../../src/app';
import { installRuntime } from '../../src/runtime';
import { as, fakeDb, resetDb, UIDS } from './helpers/harness';

jest.mock('firebase-admin/firestore', () => require('./helpers/firestoreMock'));
jest.mock('firebase-admin/app', () => ({ initializeApp: () => ({}), cert: () => ({}), applicationDefault: () => ({}), getApps: () => [] }));
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: async (token: string) => {
      if (!token.startsWith('tok-')) throw new Error('invalid token');
      return { uid: token.slice(4) };
    },
  }),
}));
jest.mock('../../src/integrations/redis/createLiveDriverLocationStore', () => {
  const { InMemoryLiveDriverLocationStore } = require('../../src/integrations/redis/LiveDriverLocationStore');
  const store = new InMemoryLiveDriverLocationStore(300_000);
  return { createLiveDriverLocationStore: () => store };
});

beforeAll(() => {
  installRuntime();
});
beforeEach(() => resetDb());

describe('end-to-end harness', () => {
  it('boots the real app against the fake database', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });

  it('a person registers as a driver over HTTP and the data lands in the (fake) database', async () => {
    const res = await request(app).post('/auth/register').set(as(UIDS.driver)).send({ intent: 'driver', name: 'Ravi' });
    expect(res.status).toBe(201);
    expect((await request(app).get('/auth/me').set(as(UIDS.driver))).body).toMatchObject({ role: 'driver', firebaseUid: UIDS.driver });
    expect(fakeDb.read(`duo_face_identities/${UIDS.driver}`)).toMatchObject({ role: 'driver', status: 'active' });
  });

  it('rejects an unknown token and the allowlisted admin resolves as admin', async () => {
    expect((await request(app).get('/auth/me').set({ Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await request(app).get('/auth/me').set(as(UIDS.admin))).body).toMatchObject({ role: 'admin' });
  });
});
