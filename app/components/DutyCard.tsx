import { Power, PowerOff } from 'lucide-react-native';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Linking, Text, View } from 'react-native';

import { getDriverLocation } from '@/api/driver';
import { Badge, Button, Card, Muted } from '@/components/ui';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { dutyController } from '@/lib/dutyController';

function minutesAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return null;
  return minutes <= 0 ? 'just now' : `${minutes} min ago`;
}

/**
 * The on/off-duty switch. While on duty the app shares the driver's location
 * every minute (replacing the last known one) and dispatch can offer them
 * orders; going off duty stops both.
 */
export function DutyCard() {
  const snapshot = useSyncExternalStore(dutyController.subscribe, dutyController.getSnapshot);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void dutyController.refresh();
    getDriverLocation()
      .then((location) => setLastSent(location.capturedAt))
      .catch(() => setLastSent(null));
  }, []);

  useRefetchOnFocus(refresh);
  useEffect(() => {
    refresh(); // first load (focus refetch skips it)
  }, [refresh]);

  // Re-align after the app returns from the background, and keep "last sent" fresh while it is open.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    const timer = setInterval(() => {
      if (snapshot.status === 'on') refresh();
    }, 60_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [refresh, snapshot.status]);

  const { status } = snapshot;
  const on = status === 'on';
  const sent = minutesAgo(lastSent);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-base font-extrabold text-ink dark:text-ink-dark">Duty status</Text>
        <Badge
          label={on ? 'ON DUTY' : status === 'paused' ? 'PAUSED' : 'OFF DUTY'}
          tone={on ? 'success' : status === 'paused' ? 'warn' : 'neutral'}
        />
      </View>

      {!snapshot.supported ? (
        <Muted>Going on duty needs the installed app (a development or release build). It is not available in Expo Go or on the web.</Muted>
      ) : (
        <>
          <Muted>
            {on
              ? 'Your location is shared every minute so nearby orders can reach you.'
              : status === 'paused'
                ? 'You are on duty but location sharing has stopped.'
                : 'Go on duty to start receiving deliveries. Your location is shared every minute until you go off duty.'}
          </Muted>
          {on || status === 'paused' ? <Muted>Last location sent: {sent ?? 'not yet'}</Muted> : null}

          {status === 'paused' ? <Button label="Resume location sharing" onPress={() => void dutyController.resume()} /> : null}

          <Button
            label={on || status === 'paused' ? 'Go off duty' : 'Go on duty'}
            icon={on || status === 'paused' ? PowerOff : Power}
            variant={on || status === 'paused' ? 'danger' : 'primary'}
            loading={status === 'working' || status === 'loading'}
            onPress={() => void (on || status === 'paused' ? dutyController.goOffDuty() : dutyController.goOnDuty())}
          />

          {snapshot.error ? <Text className="text-sm font-medium text-red-600">{snapshot.error}</Text> : null}
          {snapshot.needsSettings ? <Button label="Open settings" variant="secondary" small onPress={() => void Linking.openSettings()} /> : null}
        </>
      )}
    </Card>
  );
}
