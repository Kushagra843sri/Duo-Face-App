import { router } from 'expo-router';
import { Clock, ClipboardList } from 'lucide-react-native';
import { FlatList, Pressable, Text, View } from 'react-native';

import { getMerchantOrders } from '@/api/merchant';
import type { MerchantOrderSummary } from '@/api/merchant';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { OrderDeliveryAction } from '@/components/OrderDeliveryAction';
import { Canvas, Card, Divider, StatusBadge } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';

function OrderRow({ order }: { order: MerchantOrderSummary }) {
  return (
    <Card className="gap-3">
      <Pressable className="gap-2" accessibilityRole="button" onPress={() => router.push(`/(merchant)/orders/${order.orderId}`)}>
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-bold text-ink dark:text-ink-dark" numberOfLines={1}>
            {order.orderId}
          </Text>
          <Text className="text-xl font-extrabold text-ink dark:text-ink-dark">₹{order.total}</Text>
        </View>
        <View className="flex-row items-center justify-between gap-2">
          <StatusBadge status={order.status} kind="order" />
          <View className="flex-row items-center gap-1.5">
            <Clock size={14} color="#9ca3af" />
            <Text className="text-xs text-muted dark:text-muted-dark">{new Date(order.createdAt).toLocaleString()}</Text>
          </View>
        </View>
      </Pressable>
      <Divider />
      <OrderDeliveryAction orderId={order.orderId} deliveryAssignment={order.deliveryAssignment} />
    </Card>
  );
}

export default function MerchantOrdersScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantOrders);
  useRefetchOnFocus(retry);

  if (isLoading) {
    return <LoadingState label="Loading orders…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No orders yet" description="Orders placed against this shop will show up here." icon={ClipboardList} />;
  }

  return (
    <Canvas>
      <FlatList
        data={data}
        keyExtractor={(item) => item.orderId}
        contentContainerClassName="gap-3 p-4"
        renderItem={({ item }) => <OrderRow order={item} />}
      />
    </Canvas>
  );
}
