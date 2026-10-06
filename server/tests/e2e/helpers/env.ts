import { randomBytes } from 'node:crypto';

/**
 * Must be the FIRST import of an end-to-end test: the server reads its
 * configuration when its modules load. Everything external is faked or
 * absent: no Firebase, no Redis (an in-memory store is injected), no
 * Cashfree, no SMS, no geocoder.
 */
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'e2e-project';
process.env.FIREBASE_CLIENT_EMAIL = 'e2e@example.com';
process.env.FIREBASE_PRIVATE_KEY = 'not-a-real-key';
process.env.PROFILE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.DELIVERY_OTP_SECRET = 'e2e-delivery-otp-secret-0123456789';
process.env.CALL_WEBHOOK_SECRET = 'e2e-call-webhook-secret-0123456789';
process.env.ADMIN_FIREBASE_UIDS = 'uid-admin';
delete process.env.REDIS_URL;
delete process.env.CASHFREE_APP_ID;
delete process.env.CASHFREE_SECRET_KEY;
delete process.env.PUSH_NOTIFICATIONS_ENABLED;
