import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { computeMapRegion } from '@/lib/deliveryMap';
import type { Coordinate } from '@/lib/deliveryMap';

interface Props {
  destination: Coordinate;
  /** Only pass a fresh driver location; stale ones must not be shown as current. */
  driverLocation?: Coordinate | null;
}

/**
 * Static map (native): destination + optional current driver marker, framed
 * to cover both. No watching or live updates — the region is computed once
 * from the points supplied at render time.
 */
/** If tiles have not drawn by then, say so instead of leaving a black box. */
const MAP_LOAD_TIMEOUT_MS = 8000;

export function DeliveryMap({ destination, driverLocation }: Props) {
  const region = computeMapRegion([destination, driverLocation]);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setTimedOut(true), MAP_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  if (!region) return null;

  return (
    <View className="gap-1">
      <View className="h-56 overflow-hidden rounded-2xl bg-surface2 dark:bg-surface2-dark">
        <MapView style={StyleSheet.absoluteFill} initialRegion={region} onMapLoaded={() => setLoaded(true)}>
          <Marker coordinate={destination} title="Delivery destination" />
          {driverLocation ? <Marker coordinate={driverLocation} title="Your last location" pinColor="blue" /> : null}
        </MapView>
      </View>
      {timedOut && !loaded ? (
        <Text className="text-xs font-medium text-amber-600">
          The map is taking too long to load. Use Navigate to open your maps app.
        </Text>
      ) : null}
      {/* Setup hint is for developers only; never shown to end users. */}
      {__DEV__ ? (
        <Text className="text-xs text-muted dark:text-muted-dark">
          Dev note: a black map usually means the Android build has no Google Maps key (GOOGLE_MAPS_ANDROID_API_KEY in app/.env.example), the Maps SDK for Android is not enabled, or billing is off.
        </Text>
      ) : null}
    </View>
  );
}
