import type { Server as HttpServer } from 'http';

import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import { z } from 'zod';

import { loadRedisUrl } from '../config/redis';
import type { FirebaseIdentityVerifier } from '../integrations/firebase/FirebaseAuthService';
import { AppError } from '../middleware/errorHandler';
import { FixedWindowLimiter } from '../middleware/rateLimit';
import { CustomerTrackingService } from '../services/customerTrackingService';
import { isTerminalCustomerStatus } from '../services/customerTrackingStatus';
import { deliveryEventHub } from './deliveryEvents';
import type { DeliveryEventHub, DeliveryTrackingEvent } from './deliveryEvents';

/** Limits (per server instance, in-memory) — see docs/decisions/023. */
export const GATEWAY_LIMITS = {
  connectAttemptsPerIpPerMinute: 30, // unauthenticated flood protection
  subscribeAttemptsPerUidPerMinute: 20, // order-id probing
  maxConcurrentSocketsPerUid: 5,
  maxRoomsPerSocket: 5,
  /** Firebase ID tokens live ~1 h; force a re-authentication before that. */
  maxSocketLifetimeMs: 55 * 60 * 1000,
} as const;

export const deliveryRoom = (orderId: string) => `delivery:${orderId}`;

const subscribePayloadSchema = z.object({ orderId: z.string().min(1).max(200) }).strict();

export interface GatewayDeps {
  verifier: FirebaseIdentityVerifier;
  trackingService?: CustomerTrackingService;
  hub?: DeliveryEventHub;
  /** Set to attach the Socket.IO Redis adapter for multi-instance fan-out. Defaults to REDIS_URL. */
  redisUrl?: string | null;
  now?: () => number;
}

type Ack = (result: { ok: boolean; error?: 'unauthorized' | 'not_found' | 'rate_limited' | 'invalid' | 'unavailable' | 'too_many' }) => void;

/**
 * Customer-facing realtime channel (Socket.IO over WebSocket).
 *
 * Auth: the Firebase ID token travels in the handshake `auth.token` (never
 * a URL). A connection identifies a Firebase user only; access to any
 * order is decided per `subscribe` by CustomerTrackingService (order.customerId
 * must equal the token's UID), server-side, before the socket joins the
 * internal room `delivery:<orderId>`. Clients cannot name or join rooms
 * themselves and there is no driver room.
 *
 * Events on the single `tracking` channel: `{type:'snapshot', tracking}`,
 * `{type:'driver_location', location}`, `{type:'delivery_status', status}`,
 * `{type:'tracking_ended'}`.
 *
 * Multi-instance: with a Redis adapter, `io.to(room).emit` from any
 * instance reaches sockets on every instance. Without Redis (REDIS_URL
 * unset) it is single-instance only.
 */
export function attachCustomerTrackingGateway(httpServer: HttpServer, deps: GatewayDeps) {
  const trackingService = deps.trackingService ?? new CustomerTrackingService();
  const hub = deps.hub ?? deliveryEventHub;
  const now = deps.now ?? Date.now;

  const io = new Server(httpServer, { serveClient: false, transports: ['websocket', 'polling'] });

  let adapterClients: Redis[] = [];
  const redisUrl = deps.redisUrl === undefined ? loadRedisUrl() : deps.redisUrl;
  if (redisUrl) {
    const pub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    pub.on('error', () => console.warn('Realtime: Redis adapter connection error'));
    sub.on('error', () => console.warn('Realtime: Redis adapter connection error'));
    adapterClients = [pub, sub];
    io.adapter(createAdapter(pub, sub));
  }

  const connectLimiter = new FixedWindowLimiter(60_000, GATEWAY_LIMITS.connectAttemptsPerIpPerMinute, now);
  const subscribeLimiter = new FixedWindowLimiter(60_000, GATEWAY_LIMITS.subscribeAttemptsPerUidPerMinute, now);
  const socketsPerUid = new Map<string, number>();

  io.use(async (socket, next) => {
    if (!connectLimiter.hit(socket.handshake.address || 'unknown').allowed) {
      next(new Error('rate_limited'));
      return;
    }
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('unauthorized'));
      return;
    }
    try {
      const identity = await deps.verifier.verifyIdToken(token);
      if ((socketsPerUid.get(identity.firebaseUid) ?? 0) >= GATEWAY_LIMITS.maxConcurrentSocketsPerUid) {
        next(new Error('rate_limited'));
        return;
      }
      socket.data.uid = identity.firebaseUid;
      next();
    } catch {
      next(new Error('unauthorized')); // never echo verifier details
    }
  });

  io.on('connection', (socket: Socket) => {
    const uid = socket.data.uid as string;
    socketsPerUid.set(uid, (socketsPerUid.get(uid) ?? 0) + 1);

    const expiry = setTimeout(() => socket.disconnect(true), GATEWAY_LIMITS.maxSocketLifetimeMs);
    expiry.unref();

    socket.on('subscribe', async (payload: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === 'function' ? ack : () => {};

      const parsed = subscribePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        reply({ ok: false, error: 'invalid' });
        return;
      }
      if (!subscribeLimiter.hit(uid).allowed) {
        reply({ ok: false, error: 'rate_limited' });
        return;
      }
      const { orderId } = parsed.data;
      const room = deliveryRoom(orderId);

      const joinedRooms = [...socket.rooms].filter((r) => r.startsWith('delivery:'));
      if (!joinedRooms.includes(room) && joinedRooms.length >= GATEWAY_LIMITS.maxRoomsPerSocket) {
        reply({ ok: false, error: 'too_many' });
        return;
      }

      try {
        // Ownership + assignment + eligibility, all server-side, BEFORE joining.
        const { tracking, joinable } = await trackingService.getSnapshot(uid, orderId);
        if (joinable) await socket.join(room);
        reply({ ok: true });
        socket.emit('tracking', { type: 'snapshot', tracking });
        if (!joinable) socket.emit('tracking', { type: 'tracking_ended' });
      } catch (err) {
        // Another customer's, a missing and a malformed order are indistinguishable.
        if (err instanceof AppError && err.statusCode === 404) reply({ ok: false, error: 'not_found' });
        else {
          console.warn('Realtime: subscribe failed (unexpected error)');
          reply({ ok: false, error: 'unavailable' });
        }
      }
    });

    socket.on('unsubscribe', (payload: unknown, ack?: Ack) => {
      const parsed = subscribePayloadSchema.safeParse(payload);
      if (parsed.success) void socket.leave(deliveryRoom(parsed.data.orderId));
      if (typeof ack === 'function') ack({ ok: parsed.success });
    });

    // A watching customer has no effect on driver GPS, the assignment or the
    // Customer App order: disconnect only drops this socket (and its rooms).
    socket.on('disconnect', () => {
      clearTimeout(expiry);
      const remaining = (socketsPerUid.get(uid) ?? 1) - 1;
      if (remaining <= 0) socketsPerUid.delete(uid);
      else socketsPerUid.set(uid, remaining);
    });
  });

  const removeSink = hub.addSink((orderId: string, event: DeliveryTrackingEvent) => {
    const room = deliveryRoom(orderId);
    io.to(room).emit('tracking', event);

    if (event.type === 'delivery_status' && isTerminalCustomerStatus(event.status)) {
      io.to(room).emit('tracking', { type: 'tracking_ended' });
      io.in(room).socketsLeave(room); // stop exposing anything further on this order
    }
  });

  return {
    io,
    async close() {
      removeSink();
      await io.close();
      await Promise.all(adapterClients.map((client) => client.quit().catch(() => undefined)));
    },
  };
}
