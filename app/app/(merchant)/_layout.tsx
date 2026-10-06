import { Tabs } from 'expo-router';
import { Boxes, ClipboardList, LayoutDashboard, Package, Truck } from 'lucide-react-native';

import { getMerchantMe } from '@/api/merchant';
import { ErrorState } from '@/components/ErrorState';
import { HeaderBack } from '@/components/HeaderBack';
import { LoadingState } from '@/components/LoadingState';
import { NotificationBell } from '@/components/NotificationBell';
import { AccentProvider } from '@/components/ui';
import { useTabOptions } from '@/constants/navigation';
import { useApiResource } from '@/hooks/useApiResource';

function MerchantTabs() {
  const tabOptions = useTabOptions();
  return (
    <Tabs screenOptions={{ headerShown: true, ...tabOptions, headerRight: () => <NotificationBell /> }}>
      <Tabs.Screen
        name="index"
        options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <LayoutDashboard color={color} size={size} /> }}
      />
      <Tabs.Screen name="profile" options={{ title: 'Profile', href: null, headerLeft: () => <HeaderBack fallback="/(merchant)" /> }} />
      <Tabs.Screen
        name="products"
        options={{ title: 'Products', tabBarIcon: ({ color, size }) => <Package color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="inventory"
        options={{ title: 'Inventory', tabBarIcon: ({ color, size }) => <Boxes color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="orders"
        options={{ title: 'Orders', headerShown: false, tabBarIcon: ({ color, size }) => <ClipboardList color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="deliveries"
        options={{ title: 'Deliveries', headerShown: false, tabBarIcon: ({ color, size }) => <Truck color={color} size={size} /> }}
      />
    </Tabs>
  );
}

/**
 * The authorization gate: GET /merchant/me runs
 * authenticateFirebase -> resolveRole -> requireRole('merchant') ->
 * requireActiveMerchantShop server-side. Nothing client-side is trusted —
 * this route group is only reachable as a real merchant experience if
 * that call succeeds. 401/403/409/network are all shown in place (not
 * silently redirected away) so the user sees why, per the error-handling
 * spec.
 */
export default function MerchantLayout() {
  const { data, isLoading, error, retry } = useApiResource(() => getMerchantMe());

  if (isLoading) {
    return (
      <AccentProvider role="merchant">
        <LoadingState label="Verifying merchant access…" />
      </AccentProvider>
    );
  }

  if (error || !data) {
    return (
      <AccentProvider role="merchant">
        <ErrorState error={error} retry={retry} forbiddenMessage="Your account is not authorized as a merchant." />
      </AccentProvider>
    );
  }

  return (
    <AccentProvider role="merchant">
      <MerchantTabs />
    </AccentProvider>
  );
}
