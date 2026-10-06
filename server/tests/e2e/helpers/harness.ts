/**
 * Shared bits of the end-to-end tests. Each test file must declare the module
 * mocks itself (jest hoists `jest.mock` per file), see `smoke.test.ts` for the
 * exact block, then import this for the actors and request helpers.
 */
import request from 'supertest';

import { fakeDb } from './firestoreMock';

/** Tokens the mocked Firebase Auth accepts: `tok-<uid>`. */
export const as = (uid: string) => ({ Authorization: `Bearer tok-${uid}` });

export const UIDS = {
  customer: 'uid-customer',
  customer2: 'uid-customer-2',
  merchant: 'uid-merchant',
  driver: 'uid-driver',
  driver2: 'uid-driver-2',
  admin: 'uid-admin',
} as const;

export type Agent = ReturnType<typeof request>;

export const resetDb = () => fakeDb.reset();
export { fakeDb };
