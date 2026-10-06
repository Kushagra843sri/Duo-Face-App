import './helpers/env';

import fs from 'node:fs';
import path from 'node:path';

import request from 'supertest';

import { app } from '../../src/app';
import { as } from './helpers/harness';

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

/**
 * Contract check between the apps and the server: EVERY endpoint the customer
 * app and the merchant/driver/admin app call must exist on the server with
 * that method. The client source is read as text (no app code is run), each
 * call is turned into a request, and the real Express app must route it
 * (anything other than the generic "Route not found").
 */
const ROOT = path.resolve(__dirname, '../../..');

interface ClientCall {
  file: string;
  method: string;
  path: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'dist', 'ios', 'android'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Finds `apiRequest<...>('/path', { method: 'X' })` calls, including template-literal paths. */
function extractCalls(file: string): ClientCall[] {
  const src = fs.readFileSync(file, 'utf8');
  const calls: ClientCall[] = [];
  let i = src.indexOf('apiRequest');
  while (i !== -1) {
    let j = i + 'apiRequest'.length;
    if (src[j] === '<') {
      let depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === '<') depth++;
        else if (src[j] === '>') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
    }
    if (src[j] === '(') {
      const quote = src[j + 1];
      if (quote === "'" || quote === '"' || quote === '`') {
        const end = src.indexOf(quote, j + 2);
        const raw = src.slice(j + 2, end);
        const next = src.indexOf('apiRequest', end);
        const tail = src.slice(end, next === -1 ? end + 400 : Math.min(next, end + 400));
        const method = /method:\s*'(GET|POST|PUT|PATCH|DELETE)'/.exec(tail)?.[1] ?? 'GET';
        const rel = path.relative(ROOT, file);
        // The profile helpers take the role as a variable: expand it to the two real values so both are checked.
        const variants = raw.startsWith('/${role}/') ? ['driver', 'merchant'].map((r) => raw.replace('${role}', r)) : [raw];
        for (const v of variants) {
          if (v.startsWith('/')) calls.push({ file: rel, method, path: v.replace(/\$\{[^}]*\}/g, 'x') });
        }
      }
    }
    i = src.indexOf('apiRequest', i + 1);
  }
  return calls;
}

const clientFiles = [...walk(path.join(ROOT, 'customer')), ...walk(path.join(ROOT, 'app'))].filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
const calls = clientFiles.flatMap(extractCalls);
const unique = [...new Map(calls.map((c) => [`${c.method} ${c.path}`, c])).values()];

describe('what the apps call exists on the server', () => {
  it('found a realistic number of client calls (guards against the extractor silently finding nothing)', () => {
    expect(unique.length).toBeGreaterThan(60);
    expect(unique.some((c) => c.file.startsWith('customer'))).toBe(true);
    expect(unique.some((c) => c.file.startsWith('app'))).toBe(true);
  });

  it.each(unique.map((c) => [`${c.method} ${c.path}`, c] as const))('%s', async (_label, call) => {
    const send = request(app)[call.method.toLowerCase() as 'get'](call.path).set(as('uid-probe'));
    const res = call.method === 'GET' || call.method === 'DELETE' ? await send : await send.send({});
    expect({ status: res.status, message: res.body?.message }).not.toEqual({ status: 404, message: 'Route not found' });
  });
});
