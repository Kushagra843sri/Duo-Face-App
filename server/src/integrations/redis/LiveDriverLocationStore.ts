import type { LiveDriverLocation } from '../../types/liveDriverLocation';

/** Redis unreachable / timed out / a command failed / not configured. Carries no detail on purpose. */
export class LiveLocationUnavailableError extends Error {
  constructor() {
    super('live location store unavailable');
    this.name = 'LiveLocationUnavailableError';
  }
}

/**
 * The live-tracking transport/state layer (docs/decisions/022). Every
 * implementation must throw LiveLocationUnavailableError (nothing else) on
 * infrastructure failure, so callers can answer 503 instead of pretending
 * a position was stored — and must NEVER fall back to Firestore.
 */
export interface LiveDriverLocationStore {
  update(location: LiveDriverLocation): Promise<void>;
  get(driverId: string): Promise<LiveDriverLocation | null>;
  has(driverId: string): Promise<boolean>;
  remove(driverId: string): Promise<void>;
}

/** Used when REDIS_URL is unset: every operation is a controlled "unavailable". */
export class UnavailableLiveDriverLocationStore implements LiveDriverLocationStore {
  async update(): Promise<void> {
    throw new LiveLocationUnavailableError();
  }
  async get(): Promise<LiveDriverLocation | null> {
    throw new LiveLocationUnavailableError();
  }
  async has(): Promise<boolean> {
    throw new LiveLocationUnavailableError();
  }
  async remove(): Promise<void> {
    throw new LiveLocationUnavailableError();
  }
}

/** Test / local-dev implementation with an injectable clock and the same TTL semantics as Redis. */
export class InMemoryLiveDriverLocationStore implements LiveDriverLocationStore {
  private readonly entries = new Map<string, { location: LiveDriverLocation; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async update(location: LiveDriverLocation): Promise<void> {
    this.entries.set(location.driverId, { location: { ...location }, expiresAt: this.now() + this.ttlMs });
  }

  async get(driverId: string): Promise<LiveDriverLocation | null> {
    const entry = this.entries.get(driverId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(driverId);
      return null;
    }
    return { ...entry.location };
  }

  async has(driverId: string): Promise<boolean> {
    return (await this.get(driverId)) !== null;
  }

  async remove(driverId: string): Promise<void> {
    this.entries.delete(driverId);
  }
}
