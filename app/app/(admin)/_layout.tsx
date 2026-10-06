import { Stack } from 'expo-router';
import { LogOut } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { getAdminMe } from '@/api/admin';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { AccentProvider, usePalette } from '@/components/ui';
import { useHeaderOptions } from '@/constants/navigation';
import { useApiResource } from '@/hooks/useApiResource';
import { authService } from '@/lib/authService';

function AdminStack() {
  const header = useHeaderOptions();
  const palette = usePalette();
  return (
    <Stack screenOptions={header}>
      <Stack.Screen
        name="index"
        options={{
          title: 'Refunds',
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Sign out" hitSlop={10} onPress={() => authService.signOut()} style={{ paddingHorizontal: 12 }}>
              <LogOut size={22} color={palette.text} />
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="refund/[orderId]" options={{ title: 'Refund' }} />
    </Stack>
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
      <AdminStack />
    </AccentProvider>
  );
}
