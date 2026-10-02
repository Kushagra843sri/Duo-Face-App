import { MapPin, ShieldCheck } from 'lucide-react-native';
import { useEffect, useSyncExternalStore } from 'react';
import { Linking, Text, View } from 'react-native';

import { getDriverLocation } from '@/api/driver';
import { ApiError } from '@/api/errors';
import { Badge, Button, InfoRow, Muted, Screen, SectionCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { autoLocation } from '@/lib/autoLocation';
import type { AutoLocationPermission } from '@/lib/autoLocation';

const PERMISSION_LABEL: Record<AutoLocationPermission, string> = {
  checking: 'Checking…',
  granted: 'Allowed',
  denied: 'Not allowed',
  blocked: 'Blocked in Settings',
};

/** Fetches the stored last location; "nothing recorded yet" (404) is a normal state, not an error. */
async function loadLatest() {
  try {
    return await getDriverLocation();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Read-only view of the driver's location sharing (docs/decisions/019, 027).
 * There is no manual update: the app asks for permission when it opens and
 * then keeps the location fresh by itself (lib/autoLocation.ts); this screen
 * only shows the state, and offers a way to fix the permission if it was refused.
 */
export default function DriverLocationScreen() {
  const auto = useSyncExternalStore(autoLocation.subscribe, autoLocation.getSnapshot);
  const { data: latest, isLoading, retry } = useApiResource(loadLatest);

  // Pick up each automatic update without any button.
  useEffect(() => {
    const timer = setInterval(retry, 30_000);
    return () => clearInterval(timer);
  }, [retry]);

  const allowed = auto.permission === 'granted';

  return (
    <Screen>
      <SectionCard title="Location sharing" icon={ShieldCheck}>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted dark:text-muted-dark">Location permission</Text>
          <Badge label={PERMISSION_LABEL[auto.permission]} tone={allowed ? 'success' : auto.permission === 'checking' ? 'neutral' : 'warn'} />
        </View>
        {allowed ? (
          <Muted>Your location updates automatically every minute while the app is open, and in the background while you are on duty. Nothing to tap.</Muted>
        ) : (
          <>
            <Muted>Allow location access so nearby orders can reach you. After that it updates by itself.</Muted>
            {auto.permission === 'denied' ? <Button label="Allow location" onPress={() => void autoLocation.requestPermission()} /> : null}
            {auto.permission === 'blocked' ? <Button label="Open phone settings" variant="secondary" onPress={() => void Linking.openSettings()} /> : null}
          </>
        )}
        {auto.error ? <Text className="text-sm font-medium text-red-600">{auto.error}</Text> : null}
      </SectionCard>

      <SectionCard title="Last location" icon={MapPin}>
        {latest ? (
          <>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm text-muted dark:text-muted-dark">Status</Text>
              <Badge label={latest.freshness === 'fresh' ? 'Fresh' : 'Stale'} tone={latest.freshness === 'fresh' ? 'success' : 'warn'} />
            </View>
            <InfoRow label="Updated" value={latest.capturedAt ? new Date(latest.capturedAt).toLocaleString() : 'Unknown'} />
            <InfoRow label="Latitude" value={latest.latitude.toFixed(5)} />
            <InfoRow label="Longitude" value={latest.longitude.toFixed(5)} />
            {latest.accuracyMeters !== undefined ? <InfoRow label="Accuracy" value={`${latest.accuracyMeters.toFixed(0)} m`} /> : null}
          </>
        ) : (
          <Muted>{isLoading ? 'Loading…' : allowed ? 'Sending your first location…' : 'No location has been shared yet.'}</Muted>
        )}
      </SectionCard>
    </Screen>
  );
}
