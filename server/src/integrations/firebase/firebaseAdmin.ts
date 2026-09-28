import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';

let app: App | undefined;

/**
 * Lazily initializes the Firebase Admin SDK on first use, not at import time —
 * so the server can boot without Firebase credentials configured (no Firebase
 * project exists yet, see docs/decisions/002-customer-app-integration.md).
 * Throws a clear, specific error only when something actually tries to use it
 * without credentials present, rather than inventing a default.
 */
export function getFirebaseAdminApp(): App {
  if (app) return app;

  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    throw new Error(
      'Firebase Admin SDK is not configured — FIREBASE_PROJECT_ID is missing. See server/.env.example.'
    );
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (clientEmail && privateKey) {
    app = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
    return app;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    app = initializeApp({
      credential: applicationDefault(),
      projectId,
    });
    return app;
  }

  throw new Error(
    'Firebase Admin SDK is not configured — set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, ' +
      'or GOOGLE_APPLICATION_CREDENTIALS. See server/.env.example.'
  );
}
