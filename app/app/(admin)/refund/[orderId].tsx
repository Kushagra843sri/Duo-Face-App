import { useLocalSearchParams } from 'expo-router';
import { BadgeIndianRupee, Phone, RefreshCw, Store } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Linking, Text } from 'react-native';

import { ApiError } from '@/api/client';
import { getRefund, refreshRefund, startRefund } from '@/api/admin';
import type { RefundItem } from '@/api/admin';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Button, InfoRow, Muted, Screen, SectionCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { confirmAlert } from '@/lib/alerts';
import { formatPaise } from '@/lib/money';
import { REFUND_REASON_LABEL, REFUND_STATE_LABEL, REFUND_STATE_TONE, shortOrderRef } from '@/lib/refunds';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

export default function RefundDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { data, isLoading, error, retry } = useApiResource(() => getRefund(orderId), [orderId]);
  // The newest copy the server returned from an action; shown until the next fresh load.
  const [latest, setLatest] = useState<RefundItem | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = useRef(false);

  const item = latest ?? data;

  if (isLoading && !item) return <LoadingState label="Loading refund…" />;
  if (error && !item) return <ErrorState error={error} retry={retry} />;
  if (!item) return null;

  async function run(action: () => Promise<RefundItem>) {
    if (busy.current) return; // one action at a time: no double submits
    busy.current = true;
    setWorking(true);
    setActionError(null);
    try {
      setLatest(await action());
    } catch (err) {
      setActionError(describeError(err));
      retry(); // the server may have recorded progress even though the call failed
      setLatest(null);
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  const { state } = item.refund;
  const amount = formatPaise(item.paidAmountPaise);

  function confirmRefund() {
    confirmAlert({
      title: `Refund ${amount}?`,
      message: `This sends ${amount} back to the customer's original payment method through Cashfree. It cannot be undone.`,
      confirmLabel: `Refund ${amount}`,
      destructive: true,
      onConfirm: () => void run(() => startRefund(orderId)),
    });
  }

  const footer =
    state === 'due' || state === 'failed' ? (
      <>
        {actionError ? <Text className="text-sm font-medium text-red-600">{actionError}</Text> : null}
        <Button icon={BadgeIndianRupee} label={state === 'failed' ? `Try refund again (${amount})` : `Refund ${amount}`} loading={working} onPress={confirmRefund} />
      </>
    ) : state === 'processing' ? (
      <>
        {actionError ? <Text className="text-sm font-medium text-red-600">{actionError}</Text> : null}
        <Button icon={RefreshCw} variant="secondary" label="Check status" loading={working} onPress={() => void run(() => refreshRefund(orderId))} />
      </>
    ) : actionError ? (
      <Text className="text-sm font-medium text-red-600">{actionError}</Text>
    ) : undefined;

  return (
    <Screen footer={footer}>
      <SectionCard title={`${item.shopName || 'Order'} · ${shortOrderRef(item.orderId)}`} icon={Store}>
        <Badge label={REFUND_STATE_LABEL[state]} tone={REFUND_STATE_TONE[state]} />
        <Text className="text-sm text-ink dark:text-ink-dark">{REFUND_REASON_LABEL[item.reason]}.</Text>
        {item.createdAt ? <Muted>Order placed {new Date(item.createdAt).toLocaleString()}</Muted> : null}
      </SectionCard>

      <SectionCard title="Amount" icon={BadgeIndianRupee}>
        <InfoRow label="Order total" value={formatPaise(item.totalPaise)} />
        <InfoRow label="Paid by the customer" value={amount} strong />
        <Muted>A refund always returns the full amount paid.</Muted>
      </SectionCard>

      {item.deliveryPhone ? (
        <SectionCard title="Customer" icon={Phone}>
          <InfoRow label="Phone" value={item.deliveryPhone} />
          <Button small variant="secondary" icon={Phone} label="Call customer" onPress={() => void Linking.openURL(`tel:${item.deliveryPhone}`)} />
        </SectionCard>
      ) : null}

      <SectionCard title="Refund status">
        {state === 'due' ? <Muted>No refund has been started yet.</Muted> : null}
        {state === 'processing' ? (
          <Muted>The refund was sent to Cashfree and is being processed. Banks can take a few days. This updates automatically; you can also check now.</Muted>
        ) : null}
        {state === 'failed' ? <Muted>Cashfree could not complete the previous attempt. You can try again; the customer has not been refunded.</Muted> : null}
        {state === 'refunded' ? <Muted>The refund was completed.</Muted> : null}
        {item.refund.attempt > 0 ? <InfoRow label="Attempt" value={String(item.refund.attempt)} /> : null}
        {item.refund.requestedAt ? <InfoRow label="Requested" value={new Date(item.refund.requestedAt).toLocaleString()} /> : null}
        {item.refund.processedAt ? <InfoRow label="Finished" value={new Date(item.refund.processedAt).toLocaleString()} /> : null}
      </SectionCard>
    </Screen>
  );
}
