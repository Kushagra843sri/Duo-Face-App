import { Map as MapIcon, Navigation } from 'lucide-react-native';
import { Linking, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { getDriverLocation } from '@/api/driver';
import { DeliveryMap } from '@/components/DeliveryMap';
import { describeError } from '@/components/ErrorState';
import { Button, Muted, SectionCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { showAlert } from '@/lib/alerts';
import { buildNavigationUrl, describeDriverLocation, isValidCoordinate } from '@/lib/deliveryMap';
import type { Coordinate } from '@/lib/deliveryMap';
import { getLocationPermission } from '@/lib/locationService';

interface Props {
  /** From the delivery-order DTO. Absent when the server has no geocoding configured or could not resolve the address. */
  destination?: Coordinate;
}

async function loadLocationContext() {
  const location = await getDriverLocation().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null; // none recorded yet
    throw error;
  });
  // Read-only permission check (never prompts).
  const permission = await getLocationPermission().catch(() => null);
  return { location, permissionDenied: permission?.status === 'denied' };
}

/**
 * Map + external navigation for the driver's own assignment. Reads the
 * driver's latest stored location ONCE on mount (Phase 18's GET
 * /driver/location) — no polling, timers or watchers — and never blocks the
 * rest of the assignment screen: every failure is shown inline.
 */
export function DriverDeliveryMapSection({ destination }: Props) {
  const { data, isLoading, error, retry } = useApiResource(loadLocationContext);

  const status = data ? describeDriverLocation(data.location, data.permissionDenied) : null;
  const hasDestination = isValidCoordinate(destination);
  const errorText = error ? (describeError(error).description ?? describeError(error).title) : null;

  async function openInMaps() {
    const url = buildNavigationUrl(destination);
    if (!url) {
      showAlert('Map location unavailable', 'The delivery address could not be located on a map. Use the address above.');
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      showAlert('Could not open Maps', 'No app was able to open the map link.');
    }
  }

  return (
    <SectionCard title="Map" icon={MapIcon}>
      {hasDestination ? <DeliveryMap destination={destination} driverLocation={status?.point} /> : <Muted>Map location unavailable for this address.</Muted>}

      {isLoading ? <Muted>Checking your location…</Muted> : null}
      {status ? <Muted>{status.text}</Muted> : null}
      {errorText ? (
        <View className="gap-2">
          <Text className="text-sm text-red-600">Could not load your location: {errorText}</Text>
          <Button label="Retry" variant="secondary" small onPress={retry} />
        </View>
      ) : null}

      <Button label="Navigate" icon={Navigation} onPress={openInMaps} />
    </SectionCard>
  );
}
