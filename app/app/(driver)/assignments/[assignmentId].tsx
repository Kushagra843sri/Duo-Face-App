import { useLocalSearchParams } from 'expo-router';
import { Check, History, PackageCheck, X } from 'lucide-react-native';
import { useState } from 'react';
import type { DeliveryOrder } from '@/api/deliveryOrder';
import { Text, View } from 'react-native';

import {
  acceptDriverAssignment,
  getDriverAssignment,
  getDriverAssignmentOrder,
  pickupDriverAssignment,
  rejectDriverAssignment,
} from '@/api/driver';
import { describeError, ErrorState } from '@/components/ErrorState';
import { DeliveryOrderSections } from '@/components/DeliveryOrderSections';
import { DeliveryProofPanel } from '@/components/DeliveryProofPanel';
import { DriverDeliveryMapSection } from '@/components/DriverDeliveryMapSection';
import { LiveTrackingSection } from '@/components/LiveTrackingSection';
import { LoadingState } from '@/components/LoadingState';
import { Button, Card, HorizontalProgress, InfoRow, Screen, SectionCard, StatusBadge } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { confirmAlert, showAlert } from '@/lib/alerts';

/** Happy-path order; rejected/cancelled assignments don't show the progress bar. */
const PROGRESS_STEPS = ['assigned', 'accepted', 'picked_up', 'delivered'];
const PROGRESS_LABELS = ['Assigned', 'Accepted', 'Picked up', 'Delivered'];

export default function DriverAssignmentDetailScreen() {
  const { assignmentId } = useLocalSearchParams<{ assignmentId: string }>();
  const { data, isLoading, error, retry } = useApiResource(() => getDriverAssignment(assignmentId), [assignmentId]);
  const [isMutating, setIsMutating] = useState(false);
  // The loaded order (destination) is needed outside the order sections too.
  const [order, setOrder] = useState<DeliveryOrder | null>(null);

  async function runMutation(mutation: () => Promise<unknown>) {
    setIsMutating(true);
    try {
      await mutation();
      retry();
    } catch (mutationError) {
      const { title, description } = describeError(mutationError);
      showAlert(title, description);
    } finally {
      setIsMutating(false);
    }
  }

  function confirmReject() {
    confirmAlert({
      title: 'Reject assignment?',
      message: 'This cannot be undone.',
      confirmLabel: 'Reject',
      destructive: true,
      onConfirm: () => runMutation(() => rejectDriverAssignment(assignmentId)),
    });
  }

  if (isLoading) {
    return <LoadingState label="Loading assignment…" />;
  }

  if (error || !data) {
    return <ErrorState error={error} retry={retry} />;
  }

  const progressIndex = PROGRESS_STEPS.indexOf(data.status);

  // Sticky bottom bar: only the actions valid for the current status.
  const footer =
    data.status === 'assigned' ? (
      <>
        <Button label="Accept delivery" icon={Check} loading={isMutating} onPress={() => runMutation(() => acceptDriverAssignment(assignmentId))} />
        <Button label="Reject" variant="ghost" icon={X} disabled={isMutating} onPress={confirmReject} />
      </>
    ) : data.status === 'accepted' ? (
      <Button label="Mark picked up" icon={PackageCheck} loading={isMutating} onPress={() => runMutation(() => pickupDriverAssignment(assignmentId))} />
    ) : data.status === 'picked_up' ? (
      <DeliveryProofPanel assignmentId={assignmentId} destination={order?.destination} onDelivered={retry} />
    ) : undefined;

  return (
    <Screen footer={footer}>
      <Card className="gap-4">
        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">Delivery status</Text>
          <StatusBadge status={data.status} kind="assignment" />
        </View>
        {progressIndex >= 0 ? <HorizontalProgress labels={PROGRESS_LABELS} activeIndex={progressIndex} /> : null}
      </Card>

      <DeliveryOrderSections assignmentId={assignmentId} fetchOrder={() => getDriverAssignmentOrder(assignmentId)} onLoaded={setOrder}>
        {(order) => <DriverDeliveryMapSection destination={order.destination} />}
      </DeliveryOrderSections>

      <LiveTrackingSection assignmentId={data.assignmentId} status={data.status} />

      <SectionCard title="Timeline" icon={History}>
        <InfoRow label="Assignment ID" value={data.assignmentId} />
        {data.assignedAt ? <InfoRow label="Assigned" value={new Date(data.assignedAt).toLocaleString()} /> : null}
        {data.acceptedAt ? <InfoRow label="Accepted" value={new Date(data.acceptedAt).toLocaleString()} /> : null}
        {data.rejectedAt ? <InfoRow label="Rejected" value={new Date(data.rejectedAt).toLocaleString()} /> : null}
        {data.pickedUpAt ? <InfoRow label="Picked up" value={new Date(data.pickedUpAt).toLocaleString()} /> : null}
        {data.deliveredAt ? <InfoRow label="Delivered" value={new Date(data.deliveredAt).toLocaleString()} /> : null}
      </SectionCard>
    </Screen>
  );
}
