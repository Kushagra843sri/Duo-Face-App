import { useLocalSearchParams } from 'expo-router';
import { CreditCard, MapPin, Package, Truck } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { getMerchantOrder } from '@/api/merchant';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { OrderDeliveryAction } from '@/components/OrderDeliveryAction';
import { Card, Divider, InfoRow, Screen, SectionCard, StatusBadge } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';

export default function MerchantOrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data, isLoading, error, retry } = useApiResource(() => getMerchantOrder(orderId), [orderId]);
  useRefetchOnFocus(retry);

  if (isLoading) {
    return <LoadingState label="Loading order…" />;
  }

  if (error || !data) {
    return <ErrorState error={error} retry={retry} />;
  }

  // No Accept/Reject/Prepare/Ready/Dispatch/Deliver buttons — there is no
  // valid Customer App merchant transition mechanism (docs/decisions/011).

  return (
    <Screen>
      <Card className="gap-2">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-lg font-extrabold text-ink dark:text-ink-dark" numberOfLines={1}>
            {data.orderId}
          </Text>
          <StatusBadge status={data.status} kind="order" />
        </View>
        <Text className="text-sm text-muted dark:text-muted-dark">Placed {new Date(data.createdAt).toLocaleString()}</Text>
      </Card>

      <SectionCard title="Items" icon={Package}>
        {data.items.map((item) => (
          <View key={item.productId} className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-sm text-ink dark:text-ink-dark">
              {item.name} <Text className="text-muted dark:text-muted-dark">× {item.quantity}</Text>
            </Text>
            <Text className="text-sm font-bold text-ink dark:text-ink-dark">₹{item.subtotal}</Text>
          </View>
        ))}
        <Divider />
        <InfoRow label="Total" value={`₹${data.total}`} strong />
      </SectionCard>

      <SectionCard title="Deliver to" icon={MapPin}>
        <InfoRow label="Label" value={data.delivery.label} />
        <InfoRow label="Address" value={data.delivery.fullAddress} />
        <InfoRow label="Phone" value={data.delivery.phoneNumber} />
      </SectionCard>

      <SectionCard title="Delivery assignment" icon={Truck}>
        <OrderDeliveryAction orderId={data.orderId} deliveryAssignment={data.deliveryAssignment} />
      </SectionCard>

      <SectionCard title="Payment" icon={CreditCard}>
        <InfoRow label="Status" value={data.paymentStatus} />
      </SectionCard>
    </Screen>
  );
}
