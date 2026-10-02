import * as Location from 'expo-location';

import { ApiError } from '@/api/client';
import { getDriverDuty, setDriverDuty, updateDriverLocation } from '@/api/driver';
import { decideReconcile, DUTY_UPDATE_INTERVAL_MS } from '@/lib/dutyPolicy';
import { DUTY_LOCATION_TASK, isDutyTrackingSupported } from '@/lib/dutyTask';
import {
  getBackgroundLocationPermission,
  getLocationPermission,
  requestBackgroundLocationPermission,
  requestLocationPermission,
  toDriverLocationInput,
} from '@/lib/locationService';
import { previewRole } from '@/lib/preview';

export type DutyStatus = 'loading' | 'off' | 'on' | 'paused' | 'working';

export interface DutySnapshot {
  status: DutyStatus;
  /** False on web / Expo Go: background location needs a development build. */
  supported: boolean;
  error: string | null;
  /** The driver must change a device setting (location "Allow all the time"). */
  needsSettings: boolean;
}

/** Preview mode has no device tracking, but the on/off flow is still exercised against sample data. */
const canRun = isDutyTrackingSupported || !!previewRole;

const INITIAL: DutySnapshot = { status: 'loading', supported: canRun, error: null, needsSettings: false };

class PermissionError extends Error {}

/**
 * The driver's own on/off-duty switch (docs/decisions/027). While on duty the
 * OS-level background task (lib/dutyTask.ts) sends a location every minute;
 * the server replaces the single "last known location" document each time.
 *
 * The server is the source of truth for "on duty" (dispatch reads it); the
 * device task is just the sender, and reconcile() re-aligns the two on launch.
 */
class DutyController {
  private snapshot: DutySnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private busy = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(next: Partial<DutySnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }

  private async taskRunning(): Promise<boolean> {
    if (!isDutyTrackingSupported) return false;
    try {
      return await Location.hasStartedLocationUpdatesAsync(DUTY_LOCATION_TASK);
    } catch {
      return false;
    }
  }

  private async startTask(): Promise<void> {
    if (!isDutyTrackingSupported) return;
    await Location.startLocationUpdatesAsync(DUTY_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      // Android honours timeInterval; iOS ignores it and reports as the phone moves.
      timeInterval: DUTY_UPDATE_INTERVAL_MS,
      distanceInterval: 0,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.AutomotiveNavigation,
      // Android requires a visible notification while a foreground service runs.
      foregroundService: {
        notificationTitle: 'Duo-Face — you are on duty',
        notificationBody: 'Sharing your location every minute so you can receive deliveries.',
        notificationColor: '#4f46e5',
      },
    });
  }

  private async stopTask(): Promise<void> {
    if (!isDutyTrackingSupported) return;
    try {
      if (await Location.hasStartedLocationUpdatesAsync(DUTY_LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(DUTY_LOCATION_TASK);
      }
    } catch {
      // Already stopped.
    }
  }

  /** Foreground first, then background ("Allow all the time"). Throws PermissionError with a driver-facing message. */
  private async ensurePermissions(): Promise<void> {
    if (!isDutyTrackingSupported) return;
    let foreground = await getLocationPermission();
    if (foreground.status !== 'granted' && foreground.canAskAgain) foreground = await requestLocationPermission();
    if (foreground.status !== 'granted') throw new PermissionError('Location permission is required to go on duty.');

    let background = await getBackgroundLocationPermission();
    if (background.status !== 'granted') background = await requestBackgroundLocationPermission();
    if (background.status !== 'granted') {
      throw new PermissionError('Choose "Allow all the time" for location so you keep receiving deliveries when the screen is off.');
    }
  }

  private messageFor(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 409) return error.message;
      if (error.status === 401 || error.status === 403) return 'Your session cannot go on duty. Please sign in again.';
    }
    if (error instanceof PermissionError) return error.message;
    return 'Something went wrong. Please try again.';
  }

  /** Aligns device and server. Safe to call on launch and on screen focus. */
  async refresh(): Promise<void> {
    if (!canRun || this.busy) return;
    try {
      const duty = await getDriverDuty();
      const hasBackground = isDutyTrackingSupported ? (await getBackgroundLocationPermission()).status === 'granted' : true;
      const plan = decideReconcile({ serverOnDuty: duty.onDuty, taskRunning: await this.taskRunning(), hasBackgroundPermission: hasBackground });

      if (plan.action === 'stop-task') await this.stopTask();
      let state = plan.state;
      if (plan.action === 'start-task') {
        try {
          await this.startTask();
        } catch {
          state = 'paused';
        }
      }
      this.set({ status: state, error: state === 'paused' ? 'Location sharing is paused. Tap to resume.' : null, needsSettings: false });
    } catch (error) {
      // Offline etc.: don't pretend to know. Keep whatever was shown, surface the problem.
      this.set({ status: this.snapshot.status === 'loading' ? 'off' : this.snapshot.status, error: this.messageFor(error) });
    }
  }

  async goOnDuty(): Promise<void> {
    if (!canRun || this.busy) return;
    this.busy = true;
    this.set({ status: 'working', error: null, needsSettings: false });
    let serverOn = false;
    try {
      await this.ensurePermissions();
      await setDriverDuty(true);
      serverOn = true;
      await this.startTask();
      // Don't wait a whole minute for the first fix: send one now (best effort).
      if (isDutyTrackingSupported) {
        try {
          const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          await updateDriverLocation(toDriverLocationInput(position.coords));
        } catch {
          // The scheduled task will send the next one.
        }
      }
      this.set({ status: 'on' });
    } catch (error) {
      if (serverOn) await setDriverDuty(false).catch(() => {}); // couldn't start sending: don't claim to be on duty
      this.set({ status: 'off', error: this.messageFor(error), needsSettings: error instanceof PermissionError });
    } finally {
      this.busy = false;
    }
  }

  /** Server first: a 409 (delivery still active) must leave the device sending. */
  async goOffDuty(): Promise<void> {
    if (!canRun || this.busy) return;
    this.busy = true;
    const previous = this.snapshot.status === 'paused' ? 'paused' : 'on';
    this.set({ status: 'working', error: null, needsSettings: false });
    try {
      await setDriverDuty(false);
      await this.stopTask();
      this.set({ status: 'off' });
    } catch (error) {
      this.set({ status: previous, error: this.messageFor(error) });
    } finally {
      this.busy = false;
    }
  }

  /** "Paused" -> sending again (permissions permitting). */
  async resume(): Promise<void> {
    if (!canRun || this.busy) return;
    this.busy = true;
    this.set({ status: 'working', error: null, needsSettings: false });
    try {
      await this.ensurePermissions();
      await this.startTask();
      this.set({ status: 'on' });
    } catch (error) {
      this.set({ status: 'paused', error: this.messageFor(error), needsSettings: error instanceof PermissionError });
    } finally {
      this.busy = false;
    }
  }
}

export const dutyController = new DutyController();
