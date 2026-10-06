import { useRouter } from 'expo-router';
import { BadgeCheck } from 'lucide-react-native';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { listRefunds } from '@/api/admin';
import type { RefundItem } from '@/api/admin';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Canvas, Muted, PressableCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { formatPaise } from '@/lib/money';
import { REFUND_STATE_LABEL, REFUND_STATE_TONE, shortOrderRef } from '@/lib/refunds';

function RefundCard({ item, onPress }: { item: RefundItem; onPress: () => void }) {
  return (
    <PressableCard onPress={onPress} accentEdge={item.refund.state === 'due' || item.refund.state === 'failed'}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-bold text-ink dark:text-ink-dark" numberOfLines={1}>
          {item.shopName || 'Order'} · {shortOrderRef(item.orderId)}
        </Text>
        <Text className="text-base font-extrabold text-ink dark:text-ink-dark">{formatPaise(item.paidAmountPaise)}</Text>
      </View>
      <View className="flex-row items-center justify-between gap-2">
        <Muted>{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''}</Muted>
        <Badge label={REFUND_STATE_LABEL[item.refund.state]} tone={REFUND_STATE_TONE[item.refund.state]} />
      </View>
    </PressableCard>
  );
}

function Section({ title, items, onOpen }: { title: string; items: RefundItem[]; onOpen: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-xs font-bold uppercase tracking-wider text-muted dark:text-muted-dark">
        {title} ({items.length})
      </Text>
      {items.map((item) => (
        <RefundCard key={item.orderId} item={item} onPress={() => onOpen(item.orderId)} />
      ))}
    </View>
  );
}

export default function RefundsScreen() {
  const router = useRouter();
  const { data, isLoading, error, retry } = useApiResource(listRefunds);
  useRefetchOnFocus(retry);

  if (isLoading && !data) return <LoadingState label="Loading refunds…" />;
  if (error && !data) return <ErrorState error={error} retry={retry} forbiddenMessage="Your account is not authorized as an admin." />;
  if (!data) return null;

  if (data.open.length === 0 && data.refunded.length === 0) {
    return <EmptyState title="Nothing to refund" description="Orders that need a refund will appear here." icon={BadgeCheck} />;
  }

  const open = (id: string) => router.push({ pathname: '/(admin)/refund/[orderId]', params: { orderId: id } });
  const needsAction = data.open.filter((r) => r.refund.state === 'due' || r.refund.state === 'failed');
  const inProgress = data.open.filter((r) => r.refund.state === 'processing');

  return (
    <Canvas>
      <ScrollView contentContainerClassName="gap-6 p-4 pb-10" refreshControl={<RefreshControl refreshing={isLoading} onRefresh={retry} />}>
        {needsAction.length === 0 ? <Muted>Nothing needs a refund right now.</Muted> : null}
        <Section title="Needs refund" items={needsAction} onOpen={open} />
        <Section title="In progress" items={inProgress} onOpen={open} />
        <Section title="Refunded" items={data.refunded} onOpen={open} />
      </ScrollView>
    </Canvas>
  );
}
