import { router, useLocalSearchParams } from 'expo-router';
import { History, Receipt, User } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { getMerchantDelivery, getMerchantDeliveryOrder } from '@/api/merchant';
import { DeliveryOrderSections } from '@/components/DeliveryOrderSections';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Avatar, Button, Card, InfoRow, Screen, SectionCard, StatusBadge, VerticalSteps } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { buildDeliveryTimeline, formatTimestamp } from '@/lib/deliveryTimeline';

/**
 * Read-only by design: the assignment lifecycle (accept / reject / pick up /
 * deliver) is Driver-only (docs/decisions/016), so there are deliberately
 * no mutation controls here.
 */
export default function MerchantDeliveryDetailScreen() {
  const { assignmentId } = useLocalSearchParams<{ assignmentId: string }>();
  const { data, isLoading, error, retry } = useApiResource(() => getMerchantDelivery(assignmentId), [assignmentId]);

  if (isLoading) {
    return <LoadingState label="Loading delivery…" />;
  }

  if (error || !data) {
    return <ErrorState error={error} retry={retry} />;
  }

  return (
    <Screen>
      <Card className="gap-3">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-lg font-extrabold text-ink dark:text-ink-dark" numberOfLines={1}>
            Order {data.orderId}
          </Text>
          <StatusBadge status={data.status} kind="assignment" />
        </View>
        <InfoRow label="Assignment" value={data.assignmentId} />
        <Button label="View order" variant="secondary" small icon={Receipt} onPress={() => router.push(`/(merchant)/orders/${data.orderId}`)} />
      </Card>

      <SectionCard title="Driver" icon={User}>
        <View className="flex-row items-center gap-3">
          <Avatar name={data.driverName ?? '?'} />
          <View className="flex-1">
            <Text className="text-base font-bold text-ink dark:text-ink-dark">{data.driverName ?? 'Unavailable'}</Text>
            {data.driverPhoneNumber ? <Text className="text-sm text-muted dark:text-muted-dark">{data.driverPhoneNumber}</Text> : null}
          </View>
        </View>
        <InfoRow label="Driver ID" value={data.driverId} />
      </SectionCard>

      <DeliveryOrderSections assignmentId={assignmentId} fetchOrder={() => getMerchantDeliveryOrder(assignmentId)} />

      <SectionCard title="Timeline" icon={History}>
        <VerticalSteps steps={buildDeliveryTimeline(data).map((entry) => ({ label: entry.label, detail: formatTimestamp(entry.iso), done: true }))} />
      </SectionCard>
    </Screen>
  );
}
