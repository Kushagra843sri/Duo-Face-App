import { Radio, Square } from 'lucide-react-native';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Text, View } from 'react-native';

import type { DriverAssignment } from '@/api/driver';
import { Badge, Button, Muted, SectionCard } from '@/components/ui';
import { trackingController } from '@/lib/trackingController';
import { canStartTracking } from '@/lib/trackingPolicy';

interface Props {
  assignmentId: string;
  status: DriverAssignment['status'];
}

/**
 * Foreground-only live tracking control. Tracking stops when this section
 * unmounts (leaving the screen) or the app leaves the foreground.
 */
export function LiveTrackingSection({ assignmentId, status }: Props) {
  const snapshot = useSyncExternalStore(trackingController.subscribe, trackingController.getSnapshot);
  const isThisAssignment = snapshot.assignmentId === assignmentId;
  const active = snapshot.status === 'active' && isThisAssignment;
  const starting = snapshot.status === 'starting' && isThisAssignment;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void trackingController.stopTracking();
    });
    return () => {
      subscription.remove();
      void trackingController.stopTracking();
    };
  }, []);

  // Not tracking-eligible (assigned / delivered / ...) and not running: nothing to offer.
  if (!canStartTracking(status) && !active) return null;

  return (
    <SectionCard title="Live tracking" icon={Radio}>
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-sm text-ink dark:text-ink-dark">
          {active ? 'Sharing your location while this screen is open.' : 'Tracking is off.'}
        </Text>
        <Badge label={active ? 'LIVE' : 'OFF'} tone={active ? 'success' : 'neutral'} />
      </View>
      {active && snapshot.lastSuccessAt ? <Muted>Last update sent: {new Date(snapshot.lastSuccessAt).toLocaleTimeString()}</Muted> : null}
      {active && !snapshot.lastSuccessAt ? <Muted>Waiting for the first location…</Muted> : null}
      {isThisAssignment && snapshot.error ? <Text className="text-sm text-red-600">{snapshot.error}</Text> : null}

      <Button
        label={active ? 'Stop live tracking' : 'Start live tracking'}
        icon={active ? Square : Radio}
        variant={active ? 'danger' : 'primary'}
        loading={starting}
        onPress={() => (active ? void trackingController.stopTracking() : void trackingController.startTracking(assignmentId))}
      />
      <Text className="text-center text-xs text-muted dark:text-muted-dark">
        Foreground only: tracking stops when you leave this screen or close the app. Your location is not shown to customers or merchants.
      </Text>
    </SectionCard>
  );
}
