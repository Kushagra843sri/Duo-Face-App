import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

import { updateDriverLocation } from '@/api/driver';
import { ApiError } from '@/api/errors';
import { shouldSendDutyFix } from '@/lib/dutyPolicy';
import { toDriverLocationInput } from '@/lib/locationService';
import { previewRole } from '@/lib/preview';

export const DUTY_LOCATION_TASK = 'duo-face-duty-location';

/**
 * Background location needs a development/production build: it does not exist
 * on web, and Expo Go cannot run TaskManager on Android (nor background on
 * iOS). In preview mode there is no backend to send to.
 */
export const isDutyTrackingSupported =
  Platform.OS !== 'web' && !previewRole && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

let lastSentAt: number | null = null;

interface LocationTaskBody {
  data?: { locations?: Location.LocationObject[] };
  error?: unknown;
}

/**
 * The task MUST be defined in the global scope of the bundle (never inside a
 * component) because the OS can start the JS app headless to deliver a
 * location. app/_layout.tsx imports this module for that reason.
 *
 * Each batch: take the newest fix, send it if the throttle allows. The
 * server REPLACES the driver's single latest-location document, so this is
 * "refresh last known location", not a history.
 */
if (isDutyTrackingSupported) {
  try {
    // Required lazily so a missing native module (Expo Go) can never crash startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TaskManager = require('expo-task-manager') as {
      defineTask: (name: string, executor: (body: LocationTaskBody) => Promise<void>) => void;
    };

    TaskManager.defineTask(DUTY_LOCATION_TASK, async ({ data, error }) => {
      if (error) return;
      const latest = data?.locations?.[data.locations.length - 1];
      if (!latest) return;

      const now = Date.now();
      if (!shouldSendDutyFix(latest.coords, lastSentAt, now)) return;
      lastSentAt = now;

      try {
        await updateDriverLocation(toDriverLocationInput(latest.coords));
      } catch (sendError) {
        // Not allowed any more (signed out / suspended / not a driver): stop sending.
        if (sendError instanceof ApiError && (sendError.status === 401 || sendError.status === 403)) {
          await Location.stopLocationUpdatesAsync(DUTY_LOCATION_TASK).catch(() => {});
        }
        // Network / 5xx: keep going, the next minute retries.
      }
    });
  } catch {
    // TaskManager unavailable in this runtime: the duty UI explains why.
  }
}
