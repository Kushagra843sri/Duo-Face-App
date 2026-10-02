import { Tabs } from 'expo-router';
import { ClipboardList, LayoutDashboard, MapPin } from 'lucide-react-native';

import { getDriverMe } from '@/api/driver';
import { AutoLocation } from '@/components/AutoLocation';
import { ErrorState } from '@/components/ErrorState';
import { HeaderBack } from '@/components/HeaderBack';
import { LoadingState } from '@/components/LoadingState';
import { AccentProvider } from '@/components/ui';
import { useTabOptions } from '@/constants/navigation';
import { useApiResource } from '@/hooks/useApiResource';

function DriverTabs() {
  const tabOptions = useTabOptions();
  return (
    <>
    <AutoLocation />
      <Tabs screenOptions={{ headerShown: true, ...tabOptions }}>
        <Tabs.Screen
          name="index"
          options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard color={color} size={size} /> }}
        />
        <Tabs.Screen
          name="assignments"
          options={{
            title: 'Assignments',
            headerShown: false,
            tabBarIcon: ({ color, size }) => <ClipboardList color={color} size={size} />,
          }}
        />
        <Tabs.Screen name="profile" options={{ title: 'Profile', href: null, headerLeft: () => <HeaderBack fallback="/(driver)" /> }} />
        <Tabs.Screen
          name="location"
          options={{ title: 'Location', tabBarIcon: ({ color, size }) => <MapPin color={color} size={size} /> }}
        />
      </Tabs>
    </>
  );
}

/**
 * The authorization gate: GET /driver/me runs
 * authenticateFirebase -> resolveRole -> requireRole('driver') ->
 * requireActiveDriver server-side. Nothing client-side is trusted — this
 * route group is only reachable as a real driver experience if that call
 * succeeds. 401/403/404/network are all shown in place (not silently
 * redirected away), mirroring app/(merchant)/_layout.tsx exactly.
 */
export default function DriverLayout() {
  const { data, isLoading, error, retry } = useApiResource(() => getDriverMe());

  if (isLoading) {
    return (
      <AccentProvider role="driver">
        <LoadingState label="Verifying driver access…" />
      </AccentProvider>
    );
  }

  if (error || !data) {
    return (
      <AccentProvider role="driver">
        <ErrorState error={error} retry={retry} forbiddenMessage="Your account is not authorized as a driver." />
      </AccentProvider>
    );
  }

  return (
    <AccentProvider role="driver">
      <DriverTabs />
    </AccentProvider>
  );
}
