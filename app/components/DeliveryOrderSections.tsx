import { MapPin, Package, Phone, Tag } from 'lucide-react-native';
import { useEffect } from 'react';
import { Text, View } from 'react-native';

import type { DeliveryOrder } from '@/api/deliveryOrder';
import { describeError } from '@/components/ErrorState';
import { Button, Divider, InfoRow, Muted, SectionCard, useAccentSoft } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';

function DetailLine({ icon: Icon, text }: { icon: typeof MapPin; text: string }) {
  const soft = useAccentSoft();
  return (
    <View className="flex-row items-start gap-3">
      <Icon size={18} color={soft.fg} style={{ marginTop: 2 }} />
      <Text className="flex-1 text-base text-ink dark:text-ink-dark">{text}</Text>
    </View>
  );
}

interface Props {
  /** Must go through an assignment-scoped endpoint — there is no order-by-id fetch. */
  fetchOrder: () => Promise<DeliveryOrder>;
  assignmentId: string;
  /** Rendered after the Delivery and Order sections once the order has loaded. */
  children?: (order: DeliveryOrder) => React.ReactNode;
  /** Lets the screen use the loaded order (destination, canCallCustomer) outside these sections. */
  onLoaded?: (order: DeliveryOrder) => void;
}

/**
 * Delivery + Order sections, rendered only from fields the API returned.
 * Loads independently so a missing/inconsistent order never hides the
 * assignment itself, and shows its own retry on failure.
 */
export function DeliveryOrderSections({ fetchOrder, assignmentId, children, onLoaded }: Props) {
  const { data, isLoading, error, retry } = useApiResource(fetchOrder, [assignmentId]);
  useEffect(() => {
    if (data) onLoaded?.(data);
  }, [data, onLoaded]);

  if (isLoading) {
    return (
      <SectionCard title="Delivery" icon={MapPin}>
        <Muted>Loading delivery details…</Muted>
      </SectionCard>
    );
  }

  if (error || !data) {
    const { title, description } = describeError(error);
    return (
      <SectionCard title="Delivery" icon={MapPin}>
        <Text className="text-sm font-bold text-red-600">{title}</Text>
        {description ? <Muted>{description}</Muted> : null}
        <Button label="Retry" variant="secondary" small onPress={retry} />
      </SectionCard>
    );
  }

  const { delivery } = data;
  const hasDelivery = Boolean(delivery.fullAddress || delivery.phoneNumber || delivery.label);

  return (
    <>
      <SectionCard title="Deliver to" icon={MapPin}>
        {hasDelivery ? (
          <View className="gap-3">
            {delivery.fullAddress ? <DetailLine icon={MapPin} text={delivery.fullAddress} /> : null}
            {delivery.phoneNumber ? <DetailLine icon={Phone} text={delivery.phoneNumber} /> : null}
            {delivery.label ? <DetailLine icon={Tag} text={delivery.label} /> : null}
          </View>
        ) : (
          <Muted>No delivery details available.</Muted>
        )}
      </SectionCard>

      <SectionCard title="Order" icon={Package}>
        <InfoRow label="Order ID" value={data.orderId} />
        {data.shopName ? <InfoRow label="Shop" value={data.shopName} /> : null}
        <Divider />
        {data.items.length > 0 ? (
          data.items.map((item, index) => (
            <View key={`${item.name}-${index}`} className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-sm text-ink dark:text-ink-dark">{item.name}</Text>
              <Text className="text-sm font-bold text-muted dark:text-muted-dark">× {item.quantity}</Text>
            </View>
          ))
        ) : (
          <Muted>No items listed.</Muted>
        )}
        <Divider />
        <InfoRow label="Total" value={`₹${data.total}`} strong />
      </SectionCard>

      {children?.(data)}
    </>
  );
}
