import { useEffect, useState } from 'react';
import { Crosshair, MapPin, ShieldCheck } from 'lucide-react-native';
import { ActivityIndicator, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { getDriverLocation, updateDriverLocation } from '@/api/driver';
import type { DriverLocation } from '@/api/driver';
import { describeError } from '@/components/ErrorState';
import { Badge, Button, InfoRow, Muted, Screen, SectionCard } from '@/components/ui';
import { getCurrentLocationInput, getLocationPermission, requestLocationPermission } from '@/lib/locationService';
import type { PermissionState } from '@/lib/locationService';

function permissionLabel(permission: PermissionState | null): string {
  if (!permission) return 'Checking…';
  if (permission.status === 'granted') return 'Granted';
  if (permission.status === 'denied') return permission.canAskAgain ? 'Denied' : 'Denied (enable in device Settings)';
  return 'Not requested yet';
}

/**
 * Manual, one-shot location update. Permission is only checked on entry
 * (never requested) and requested only when the driver taps a button.
 * Nothing here watches, polls or sends in the background.
 */
export default function DriverLocationScreen() {
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [latest, setLatest] = useState<DriverLocation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [perm, location] = await Promise.all([
          getLocationPermission(),
          getDriverLocation().catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return null; // nothing recorded yet
            throw error;
          }),
        ]);
        if (!cancelled) {
          setPermission(perm);
          setLatest(location);
        }
      } catch (error) {
        if (!cancelled) setMessage({ kind: 'error', text: describeError(error).description ?? describeError(error).title });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensurePermission(): Promise<PermissionState> {
    let current = await getLocationPermission();
    if (current.status !== 'granted' && current.canAskAgain) {
      current = await requestLocationPermission();
    }
    setPermission(current);
    return current;
  }

  async function run(action: () => Promise<void>) {
    if (isBusy) return;
    setIsBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      const { title, description } = describeError(error);
      setMessage({ kind: 'error', text: description ?? title });
    } finally {
      setIsBusy(false);
    }
  }

  const enableLocation = () =>
    run(async () => {
      const result = await ensurePermission();
      setMessage(
        result.status === 'granted'
          ? { kind: 'success', text: 'Location permission granted.' }
          : { kind: 'error', text: 'Location permission was not granted.' }
      );
    });

  const updateLocation = () =>
    run(async () => {
      const result = await ensurePermission();
      if (result.status !== 'granted') {
        setMessage({ kind: 'error', text: 'Location permission is required to update your location.' });
        return;
      }
      const input = await getCurrentLocationInput();
      await updateDriverLocation(input);
      setLatest(await getDriverLocation());
      setMessage({ kind: 'success', text: 'Location updated.' });
    });

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-canvas dark:bg-canvas-dark">
        <ActivityIndicator />
      </View>
    );
  }

  const granted = permission?.status === 'granted';

  return (
    <Screen>
      <SectionCard title="Permission" icon={ShieldCheck}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted dark:text-muted-dark">Location permission</Text>
          <Badge label={permissionLabel(permission)} tone={granted ? 'success' : 'warn'} />
        </View>
      </SectionCard>

      <SectionCard title="Last location" icon={MapPin}>
        {latest ? (
          <>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted dark:text-muted-dark">Status</Text>
              <Badge label={latest.freshness === 'fresh' ? 'Fresh' : 'Stale'} tone={latest.freshness === 'fresh' ? 'success' : 'warn'} />
            </View>
            <InfoRow label="Captured" value={latest.capturedAt ? new Date(latest.capturedAt).toLocaleString() : 'Unknown'} />
            {/* Debug visibility only (development). */}
            <InfoRow label="Latitude" value={latest.latitude.toFixed(5)} />
            <InfoRow label="Longitude" value={latest.longitude.toFixed(5)} />
            {latest.accuracyMeters !== undefined ? <InfoRow label="Accuracy" value={`${latest.accuracyMeters.toFixed(0)} m`} /> : null}
          </>
        ) : (
          <Muted>No location has been sent yet.</Muted>
        )}
      </SectionCard>

      {message ? (
        <Text className={`text-center text-sm font-semibold ${message.kind === 'success' ? 'text-green-600' : 'text-red-600'}`}>{message.text}</Text>
      ) : null}

      {!granted ? <Button label="Enable location" variant="secondary" disabled={isBusy} onPress={enableLocation} /> : null}
      <Button label="Update current location" icon={Crosshair} loading={isBusy} onPress={updateLocation} />
      <Text className="text-center text-xs text-muted dark:text-muted-dark">
        Your location is sent only when you tap Update. It is not tracked in the background.
      </Text>
    </Screen>
  );
}
