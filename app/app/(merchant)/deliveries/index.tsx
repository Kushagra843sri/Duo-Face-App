import { router } from 'expo-router';
import { Truck, User } from 'lucide-react-native';
import { FlatList, Text, View } from 'react-native';

import { getMerchantDeliveries } from '@/api/merchant';
import type { MerchantDeliveryAssignment } from '@/api/merchant';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Canvas, PressableCard, StatusBadge, useAccentSoft } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { buildDeliveryTimeline, formatTimestamp } from '@/lib/deliveryTimeline';

function DeliveryRow({ delivery }: { delivery: MerchantDeliveryAssignment }) {
  const soft = useAccentSoft();
  // Only the latest lifecycle event, so the list stays scannable; the full
  // timeline is on the detail screen.
  const timeline = buildDeliveryTimeline(delivery);
  const latest = timeline[timeline.length - 1];

  return (
    <PressableCard onPress={() => router.push(`/(merchant)/deliveries/${delivery.assignmentId}`)}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-bold text-ink dark:text-ink-dark" numberOfLines={1}>
          Order {delivery.orderId}
        </Text>
        <StatusBadge status={delivery.status} kind="assignment" />
      </View>
      <View className="flex-row items-center gap-1.5">
        <User size={14} color={soft.fg} />
        <Text className="text-sm text-ink dark:text-ink-dark">{delivery.driverName ?? delivery.driverId}</Text>
      </View>
      {latest ? (
        <Text className="text-xs text-muted dark:text-muted-dark">
          {latest.label}: {formatTimestamp(latest.iso)}
        </Text>
      ) : null}
    </PressableCard>
  );
}

export default function MerchantDeliveriesScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantDeliveries);
  useRefetchOnFocus(retry);

  if (isLoading) {
    return <LoadingState label="Loading deliveries…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No deliveries yet" description="Assign a driver from the Orders tab to create a delivery." icon={Truck} />;
  }

  return (
    <Canvas>
      <FlatList
        data={data}
        keyExtractor={(item) => item.assignmentId}
        contentContainerClassName="gap-3 p-4"
        renderItem={({ item }) => <DeliveryRow delivery={item} />}
      />
    </Canvas>
  );
}
