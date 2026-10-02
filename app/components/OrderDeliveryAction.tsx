import { router } from 'expo-router';
import { Send, Truck } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { requestMerchantDriver } from '@/api/merchant';
import type { MerchantOrderDeliveryAssignment } from '@/api/merchant';
import { describeError } from '@/components/ErrorState';
import { Button, StatusBadge } from '@/components/ui';
import { showAlert } from '@/lib/alerts';

// Same "active" set the backend uses to block a second assignment
// (server/src/services/deliveryAssignmentService.ts). Only used to pick
// which control to show — the server still enforces the conflict.
// 'cancelled' here means the driver never answered and the offer expired.
const TERMINAL_STATUSES = ['rejected', 'cancelled'];

interface Props {
  orderId: string;
  deliveryAssignment?: MerchantOrderDeliveryAssignment | null;
}

/**
 * The merchant only raises a request; the server picks the nearest eligible
 * driver (docs/decisions/026) — there is no driver list or picker. Assignment
 * state comes exclusively from the backend's deliveryAssignment field (the
 * real Duo-Face assignment) — never inferred from the Customer App order
 * status.
 */
export function OrderDeliveryAction({ orderId, deliveryAssignment }: Props) {
  const [isRequesting, setIsRequesting] = useState(false);
  // A ref, not just state: two taps in the same frame both see the stale
  // `false` state, so the guard has to be synchronous.
  const requestingRef = useRef(false);

  const canRequest = !deliveryAssignment || TERMINAL_STATUSES.includes(deliveryAssignment.status);
  const needsRetry = !!deliveryAssignment && TERMINAL_STATUSES.includes(deliveryAssignment.status);

  async function requestDriver() {
    if (requestingRef.current) return;
    requestingRef.current = true;
    setIsRequesting(true);
    try {
      const assignment = await requestMerchantDriver(orderId);
      router.push(`/(merchant)/deliveries/${assignment.assignmentId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // "No driver available nearby" / "Shop location unavailable" / already assigned.
        showAlert('Could not find a driver', error.message);
      } else {
        const { title, description } = describeError(error);
        showAlert(title, description);
      }
    } finally {
      requestingRef.current = false;
      setIsRequesting(false);
    }
  }

  return (
    <View className="gap-3">
      {deliveryAssignment ? (
        <View className="flex-row items-center justify-between gap-2">
          <View className="flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-sm text-muted dark:text-muted-dark">Delivery</Text>
              <StatusBadge status={deliveryAssignment.status} kind="assignment" />
            </View>
            {deliveryAssignment.status === 'assigned' ? (
              <Text className="text-xs text-muted dark:text-muted-dark">Waiting for the nearest driver to accept…</Text>
            ) : null}
            {needsRetry ? (
              <Text className="text-xs text-muted dark:text-muted-dark">The previous driver did not take this order.</Text>
            ) : null}
          </View>
          <Button
            label="View"
            variant="secondary"
            small
            icon={Truck}
            onPress={() => router.push(`/(merchant)/deliveries/${deliveryAssignment.assignmentId}`)}
          />
        </View>
      ) : null}
      {canRequest ? (
        <Button label={needsRetry ? 'Request a driver again' : 'Request driver'} icon={Send} loading={isRequesting} onPress={requestDriver} />
      ) : null}
    </View>
  );
}
