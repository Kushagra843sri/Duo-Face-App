import { router } from 'expo-router';
import { DoorClosed, DoorOpen } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Switch, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { getMerchantShop, setMerchantShopOpen } from '@/api/merchant';
import { Button, Card, IconChip, Muted } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';

/**
 * Whether customers can order from this shop right now. A new shop starts
 * closed; the owner opens it once products and stock are set. A failure to
 * load never breaks the dashboard: the card just says it could not check.
 */
export function ShopOpenCard({ productCount }: { productCount: number }) {
  const { data, isLoading, error, retry } = useApiResource(getMerchantShop);
  useRefetchOnFocus(retry);
  const [override, setOverride] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  if (isLoading && !data) return null;
  if (error || !data) {
    return (
      <Card className="gap-2">
        <Muted>Could not check whether your shop is open.</Muted>
        <Button small variant="secondary" label="Try again" onPress={retry} />
      </Card>
    );
  }
  if (!data.listed) {
    return (
      <Card>
        <Muted>Your shop is not listed for customers yet.</Muted>
      </Card>
    );
  }

  const isOpen = override ?? data.isOpen;

  async function toggle(next: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setMessage(null);
    setOverride(next); // show the change at once; undone below if the server refuses it
    try {
      await setMerchantShopOpen(next);
    } catch (err) {
      setOverride(null);
      setMessage(err instanceof ApiError ? err.message : 'Could not change that. Please try again.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <IconChip icon={isOpen ? DoorOpen : DoorClosed} />
        <View className="flex-1">
          <Text className="text-base font-bold text-ink dark:text-ink-dark">{isOpen ? 'Your shop is open' : 'Your shop is closed'}</Text>
          <Muted>{isOpen ? 'Customers can order from you.' : 'Customers can see your shop but cannot order.'}</Muted>
        </View>
        <Switch value={isOpen} onValueChange={toggle} disabled={saving} accessibilityLabel="Shop open" />
      </View>
      {!isOpen && productCount === 0 ? (
        <View className="gap-2">
          <Muted>Add your products first, then open the shop.</Muted>
          <Button small label="Add a product" onPress={() => router.push('/(merchant)/product-form')} />
        </View>
      ) : null}
      {message ? <Text className="text-sm font-medium text-red-600">{message}</Text> : null}
    </Card>
  );
}
