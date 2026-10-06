import { Tabs } from 'expo-router';
import { BadgeIndianRupee, LogOut, ShieldCheck } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { getAdminMe } from '@/api/admin';
import { ErrorState } from '@/components/ErrorState';
import { HeaderBack } from '@/components/HeaderBack';
import { LoadingState } from '@/components/LoadingState';
import { NotificationBell } from '@/components/NotificationBell';
import { AccentProvider, usePalette } from '@/components/ui';
import { useTabOptions } from '@/constants/navigation';
import { useApiResource } from '@/hooks/useApiResource';
import { authService } from '@/lib/authService';

function HeaderActions() {
  const palette = usePalette();
  return (
    <View className="flex-row items-center">
      <NotificationBell />
      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" hitSlop={10} onPress={() => authService.signOut()} style={{ paddingRight: 14 }}>
        <LogOut size={22} color={palette.text} />
      </Pressable>
    </View>
  );
}

function AdminTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tabs screenOptions={{ headerShown: true, ...tabOptions, headerRight: () => <HeaderActions /> }}>
      <Tabs.Screen name="index" options={{ title: 'Refunds', tabBarIcon: ({ color, size }) => <BadgeIndianRupee color={color} size={size} /> }} />
      <Tabs.Screen name="verifications" options={{ title: 'KYC review', tabBarIcon: ({ color, size }) => <ShieldCheck color={color} size={size} /> }} />
      {/* Detail screens: reachable from the lists, not tabs themselves. */}
      <Tabs.Screen name="refund/[orderId]" options={{ title: 'Refund', href: null, headerLeft: () => <HeaderBack fallback="/(admin)" /> }} />
      <Tabs.Screen name="review/[kind]/[ownerId]" options={{ title: 'Review', href: null, headerLeft: () => <HeaderBack fallback="/(admin)/verifications" /> }} />
    </Tabs>
  );
}

/**
 * The authorization gate: GET /admin/me runs authenticateFirebase ->
 * resolveRole -> requireRole('admin') server-side (admins are an allowlist of
 * Firebase UIDs on the server). Nothing client-side is trusted: this area is
 * only usable if that call succeeds, and every admin action is re-checked by
 * the server anyway.
 */
export default function AdminLayout() {
  const { data, isLoading, error, retry } = useApiResource(() => getAdminMe());

  if (isLoading) {
    return (
      <AccentProvider role="admin">
        <LoadingState label="Verifying admin access…" />
      </AccentProvider>
    );
  }

  if (error || !data) {
    return (
      <AccentProvider role="admin">
        <ErrorState error={error} retry={retry} forbiddenMessage="Your account is not authorized as an admin." />
      </AccentProvider>
    );
  }

  return (
    <AccentProvider role="admin">
      <AdminTabs />
    </AccentProvider>
  );
}
