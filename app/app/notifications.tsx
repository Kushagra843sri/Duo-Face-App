import { Stack, useRouter } from 'expo-router';
import { BellOff } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import { getInbox, markAllRead, markRead } from '@/api/notifications';
import type { InboxItem } from '@/api/notifications';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { AccentProvider, Canvas, Card, Muted, useAccent } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useAuthUser } from '@/hooks/useAuthUser';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { useRole } from '@/hooks/useRole';
import type { Role } from '@/types/auth';

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function InboxList({ role }: { role: Role | null }) {
  const router = useRouter();
  const accent = useAccent();
  const { data, isLoading, error, retry } = useApiResource(getInbox);
  const [readLocally, setReadLocally] = useState<Set<string>>(new Set());
  useRefetchOnFocus(retry);

  if (isLoading && !data) return <LoadingState label="Loading notifications…" />;
  if (error && !data) return <ErrorState error={error} retry={retry} />;
  if (!data) return null;

  const isRead = (n: InboxItem) => n.read || readLocally.has(n.id);
  const unread = data.notifications.filter((n) => !isRead(n)).length;

  /** Where a notification leads, by who is reading it. Nothing here trusts the notification beyond its type and order id. */
  function go(n: InboxItem) {
    if (role === 'merchant') {
      if (n.orderId) router.push({ pathname: '/(merchant)/orders/[orderId]', params: { orderId: n.orderId } });
      else if (n.type.startsWith('kyc_')) router.push('/(merchant)/profile');
    } else if (role === 'driver') {
      if (n.type === 'new_delivery_offer') router.push('/(driver)/assignments');
      else if (n.type.startsWith('kyc_')) router.push('/(driver)/profile');
    } else if (role === 'admin') {
      if (n.type === 'admin_refund_due' && n.orderId) router.push({ pathname: '/(admin)/refund/[orderId]', params: { orderId: n.orderId } });
      else if (n.type === 'admin_kyc_submitted') router.push('/(admin)/verifications');
    }
  }

  function open(n: InboxItem) {
    if (!isRead(n)) {
      setReadLocally((prev) => new Set(prev).add(n.id));
      void markRead(n.id).catch(() => undefined); // best effort: it simply stays unread on the server
    }
    go(n);
  }

  async function readAll() {
    setReadLocally(new Set(data!.notifications.map((n) => n.id)));
    try {
      await markAllRead();
    } catch {
      retry();
    }
  }

  return (
    <Canvas>
      <Stack.Screen
        options={{
          headerRight: () =>
            unread > 0 ? (
              <Pressable accessibilityRole="button" onPress={readAll} hitSlop={10} style={{ paddingHorizontal: 14 }}>
                <Text style={{ color: accent.solid }} className="text-sm font-bold">
                  Mark all read
                </Text>
              </Pressable>
            ) : null,
        }}
      />
      {data.notifications.length === 0 ? (
        <EmptyState title="No notifications yet" description="Orders, deliveries and reviews will show up here." icon={BellOff} />
      ) : (
        <FlatList
          data={data.notifications}
          keyExtractor={(n) => n.id}
          contentContainerClassName="gap-3 p-4"
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={retry} />}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => open(item)}>
              <Card className="gap-1" style={!isRead(item) ? { borderLeftWidth: 4, borderLeftColor: accent.solid } : undefined}>
                <View className="flex-row items-center justify-between gap-2">
                  <Text className={`flex-1 text-base text-ink dark:text-ink-dark ${isRead(item) ? 'font-semibold' : 'font-extrabold'}`}>{item.title}</Text>
                  <Muted>{ago(item.createdAt)}</Muted>
                </View>
                <Text className="text-sm text-ink dark:text-ink-dark">{item.body}</Text>
              </Card>
            </Pressable>
          )}
        />
      )}
    </Canvas>
  );
}

/** One inbox for every role (the server knows who is signed in); only where a tap leads depends on the role. */
export default function NotificationsScreen() {
  const { user } = useAuthUser();
  const { role } = useRole(user?.uid ?? null);
  return (
    <AccentProvider role={role ?? 'merchant'}>
      <InboxList role={role} />
    </AccentProvider>
  );
}
