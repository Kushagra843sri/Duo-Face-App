import * as Location from 'expo-location';
import { AppState } from 'react-native';

import { ApiError } from '@/api/errors';
import { updateDriverLocation } from '@/api/driver';
import { dutyController } from '@/lib/dutyController';
import { getLocationPermission, requestLocationPermission, toDriverLocationInput } from '@/lib/locationService';
import { previewRole } from '@/lib/preview';

/** Refresh cadence while the app is open. (While on duty the background task sends instead, even when the app is closed.) */
export const AUTO_LOCATION_INTERVAL_MS = 60_000;

export type AutoLocationPermission = 'checking' | 'granted' | 'denied' | 'blocked';

export interface AutoLocationSnapshot {
  permission: AutoLocationPermission;
  /** Epoch ms of the last location the server accepted. */
  lastSentAt: number | null;
  error: string | null;
}

/** Preview mode has no GPS: pretend to be in Delhi. */
const PREVIEW_POINT = { latitude: 28.5583, longitude: 77.2028, accuracy: 10 };

/**
 * Keeps the driver's last-known location fresh without any button
 * (docs/decisions/019, 027): when the driver app opens it asks for location
 * permission (once, via the OS prompt); after that it sends the current
 * position straight away, every minute while the app is in the foreground,
 * and again whenever the app comes back to the foreground. The server simply
 * replaces the single stored location each time.
 *
 * It does not run in the background by itself and it steps aside while the
 * on-duty background task is already sending.
 */
class AutoLocation {
  private snapshot: AutoLocationSnapshot = { permission: 'checking', lastSentAt: null, error: null };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private sending = false;
  private started = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(next: Partial<AutoLocationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }

  /** Call once when the (authorized) driver app is open. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const permission = await this.resolvePermission(true);
    if (permission !== 'granted') return;

    void this.sendNow();
    this.timer = setInterval(() => void this.sendNow(), AUTO_LOCATION_INTERVAL_MS);
    this.appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void this.sendNow();
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.started = false;
  }

  /** Re-asks for permission (or tells the screen it must be changed in Settings). */
  async requestPermission(): Promise<void> {
    this.stop();
    await this.start();
  }

  private async resolvePermission(askIfNeeded: boolean): Promise<AutoLocationPermission> {
    if (previewRole) {
      this.set({ permission: 'granted' });
      return 'granted';
    }
    let state = await getLocationPermission();
    if (state.status !== 'granted' && state.canAskAgain && askIfNeeded) state = await requestLocationPermission();
    const permission: AutoLocationPermission = state.status === 'granted' ? 'granted' : state.canAskAgain ? 'denied' : 'blocked';
    this.set({ permission });
    return permission;
  }

  private async sendNow(): Promise<void> {
    if (this.sending || AppState.currentState !== 'active') return;
    // The on-duty background task is already sending every minute.
    if (dutyController.getSnapshot().status === 'on') return;

    this.sending = true;
    try {
      const coords = previewRole ? PREVIEW_POINT : (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })).coords;
      await updateDriverLocation(toDriverLocationInput(coords));
      this.set({ lastSentAt: Date.now(), error: null });
    } catch (error) {
      // Offline or the server said no: keep trying on the next tick, and say so on the Location screen.
      this.set({ error: error instanceof ApiError && error.status === 403 ? 'Your account cannot share location.' : 'Could not update your location. Retrying…' });
    } finally {
      this.sending = false;
    }
  }
}

export const autoLocation = new AutoLocation();
