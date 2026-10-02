import * as Location from 'expo-location';

import type { DriverLocationInput } from '@/api/driver';

export type LocationPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface PermissionState {
  status: LocationPermissionStatus;
  /** False once the OS will no longer show the prompt (user must use Settings). */
  canAskAgain: boolean;
}

function toPermissionState(response: Location.LocationPermissionResponse): PermissionState {
  return { status: response.status as LocationPermissionStatus, canAskAgain: response.canAskAgain };
}

/** Reads the current permission without prompting. */
export async function getLocationPermission(): Promise<PermissionState> {
  return toPermissionState(await Location.getForegroundPermissionsAsync());
}

/** Shows the OS prompt (if it can). Only call from an explicit user action. */
export async function requestLocationPermission(): Promise<PermissionState> {
  return toPermissionState(await Location.requestForegroundPermissionsAsync());
}

/**
 * Pure mapping from an Expo position to the backend DTO. Expo reports
 * "unavailable" as null (or a negative heading/speed), which would fail the
 * backend's validation — those optional fields are simply omitted.
 */
export function toDriverLocationInput(coords: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}): DriverLocationInput {
  const valid = (value: number | null | undefined, max = Infinity): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    ...(valid(coords.accuracy) ? { accuracyMeters: coords.accuracy } : {}),
    ...(valid(coords.heading, 360) ? { heading: coords.heading } : {}),
    ...(valid(coords.speed) ? { speedMps: coords.speed } : {}),
  };
}

/**
 * One-shot fix for the manual "Update Current Location" action (Phase 18):
 * a single position, read only when the driver asks. Continuous updates use
 * watchForegroundLocation below, only from the live-tracking screen.
 */
export async function getCurrentLocationInput(): Promise<DriverLocationInput> {
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return toDriverLocationInput(position.coords);
}

/**
 * Foreground-only watcher for live tracking (Phase 21). The subscription
 * lives only while the app is in the foreground with the tracking UI
 * mounted — there is no background task or foreground service. The OS
 * filters by distance (and, on Android, time); lib/trackingPolicy.ts
 * applies the client-side send throttle on top.
 */
export async function watchForegroundLocation(
  onFix: (coords: Location.LocationObjectCoords) => void,
  onError: () => void,
  options: { accuracy?: Location.Accuracy; distanceInterval?: number; timeInterval?: number } = {}
): Promise<{ remove: () => void }> {
  return Location.watchPositionAsync(
    {
      accuracy: options.accuracy ?? Location.Accuracy.Balanced,
      distanceInterval: options.distanceInterval ?? 25,
      timeInterval: options.timeInterval ?? 10_000,
    },
    (position) => onFix(position.coords),
    () => onError()
  );
}

/** Reads the background ("Allow all the time") permission without prompting. */
export async function getBackgroundLocationPermission(): Promise<PermissionState> {
  return toPermissionState(await Location.getBackgroundPermissionsAsync());
}

/**
 * Asks for background location. On Android 11+ the OS cannot show this as a
 * dialog: the user is sent to Settings to choose "Allow all the time". Only
 * call from an explicit user action (the duty button).
 */
export async function requestBackgroundLocationPermission(): Promise<PermissionState> {
  return toPermissionState(await Location.requestBackgroundPermissionsAsync());
}

/** A fresh, high-accuracy one-shot fix taken at the moment the driver taps "Mark delivered". */
export async function getFreshDeliveryFix(): Promise<DriverLocationInput> {
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return toDriverLocationInput(position.coords);
}
