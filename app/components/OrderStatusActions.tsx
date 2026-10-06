import { useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { updateMerchantOrderStatus } from '@/api/merchant';
import type { MerchantOrderAction } from '@/api/merchant';
import { Button, Muted } from '@/components/ui';
import { confirmAlert } from '@/lib/alerts';
import { nextActions, nextStepHint } from '@/lib/orderActions';
import type { OrderActionOption } from '@/lib/orderActions';

/**
 * The shop's buttons for an order: accept or reject a new one, then
 * prepare and mark ready. The server decides what is allowed (and tells the
 * customer); a refused move shows its reason and the screen reloads.
 */
export function OrderStatusActions({ orderId, status, onChanged }: { orderId: string; status: string; onChanged: () => void }) {
  const [working, setWorking] = useState<MerchantOrderAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const actions = nextActions(status);
  const hint = nextStepHint(status);

  async function run(action: MerchantOrderAction) {
    if (busy.current) return; // one action at a time: no double taps
    busy.current = true;
    setWorking(action);
    setError(null);
    try {
      await updateMerchantOrderStatus(orderId, action);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the order. Please try again.');
    } finally {
      busy.current = false;
      setWorking(null);
      onChanged(); // reload either way: a 409 usually means the order already moved
    }
  }

  function press(option: OrderActionOption) {
    if (!option.destructive) return void run(option.status);
    confirmAlert({
      title: 'Reject this order?',
      message: 'The customer will be told you could not take it, and the items go back into stock. If they paid online they are refunded.',
      confirmLabel: 'Reject order',
      destructive: true,
      onConfirm: () => void run(option.status),
    });
  }

  if (actions.length === 0 && !hint) return null;

  return (
    <View className="gap-3">
      {hint ? <Muted>{hint}</Muted> : null}
      {error ? <Text className="text-sm font-medium text-red-600">{error}</Text> : null}
      {actions.map((option, index) => (
        <Button
          key={option.status}
          label={option.label}
          variant={option.destructive ? 'danger' : index === 0 ? 'primary' : 'secondary'}
          loading={working === option.status}
          disabled={working !== null && working !== option.status}
          onPress={() => press(option)}
        />
      ))}
    </View>
  );
}
