import { useEffect, useState } from 'react';
import * as Location from 'expo-location';

import { distanceMeters } from '@/lib/deliveryProximity';
import type { Point } from '@/lib/deliveryProximity';
import { getLocationPermission, requestLocationPermission, watchForegroundLocation } from '@/lib/locationService';
import { previewRole } from '@/lib/preview';

export interface Proximity {
  distanceMeters: number | null;
  accuracyMeters: number | null;
  status: 'idle' | 'locating' | 'ready' | 'denied' | 'error';
  /** Preview only: pretend the driver walked to the door. */
  simulateArrival?: () => void;
}

/** Preview mode has no GPS: start 120 m away, with a button to "arrive". */
const PREVIEW_START_METERS = 120;

/**
 * Foreground distance to the customer while `active`. The watcher lives only
 * while the delivery screen is mounted (no background use here — duty tracking
 * is separate, docs/decisions/027).
 */
export function useDeliveryProximity(destination: Point | undefined, active: boolean): Proximity {
  const [state, setState] = useState<Proximity>({ distanceMeters: null, accuracyMeters: null, status: 'idle' });
  const [previewMeters, setPreviewMeters] = useState(PREVIEW_START_METERS);

  useEffect(() => {
    if (!active || !destination || previewRole) return;
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;
    setState((s) => ({ ...s, status: 'locating' }));

    (async () => {
      try {
        let permission = await getLocationPermission();
        if (permission.status !== 'granted' && permission.canAskAgain) permission = await requestLocationPermission();
        if (permission.status !== 'granted') {
          if (!cancelled) setState({ distanceMeters: null, accuracyMeters: null, status: 'denied' });
          return;
        }
        subscription = await watchForegroundLocation(
          (coords) => {
            if (cancelled) return;
            setState({
              distanceMeters: distanceMeters(destination, coords),
              accuracyMeters: typeof coords.accuracy === 'number' ? coords.accuracy : null,
              status: 'ready',
            });
          },
          () => !cancelled && setState((s) => ({ ...s, status: 'error' })),
          { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3000 }
        );
        if (cancelled) subscription.remove();
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: 'error' }));
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [active, destination?.latitude, destination?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  if (previewRole) {
    return {
      distanceMeters: active && destination ? previewMeters : null,
      accuracyMeters: 8,
      status: active && destination ? 'ready' : 'idle',
      simulateArrival: () => setPreviewMeters(15),
    };
  }
  return state;
}
