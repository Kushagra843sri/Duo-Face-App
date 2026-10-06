import { router } from 'expo-router';
import { Eye, EyeOff, Package, Pencil, Plus, SlidersHorizontal } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';

import { createMerchantInventory, getMerchantProducts, updateMerchantProduct } from '@/api/merchant';
import type { MerchantProductCatalogEntry } from '@/api/merchant';
import { EmptyState } from '@/components/EmptyState';
import { describeError, ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Button, Canvas, Card, IconChip, Muted } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';
import { showAlert } from '@/lib/alerts';
import { formatPaise } from '@/lib/money';

interface ProductRowProps {
  item: MerchantProductCatalogEntry;
  isCreatingInventory: boolean;
  isToggling: boolean;
  onAddInventory: () => void;
  onToggleVisible: () => void;
}

function ProductRow({ item, isCreatingInventory, isToggling, onAddInventory, onToggleVisible }: ProductRowProps) {
  const inventory = item.inventory;
  const available = inventory ? inventory.quantity - inventory.reservedQuantity : 0;
  const soldOut = !inventory || available <= 0;

  return (
    <Card className="gap-3" style={!item.isActive ? { opacity: 0.7 } : undefined}>
      <View className="flex-row items-center gap-3">
        <IconChip icon={Package} />
        <View className="flex-1 gap-1">
          <Text className="text-base font-bold text-ink dark:text-ink-dark" numberOfLines={2}>
            {item.name}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {!item.isActive ? <Badge label="Hidden from customers" tone="neutral" /> : null}
            {item.isActive && soldOut ? <Badge label="Sold out" tone="danger" /> : null}
            {item.isActive && !soldOut ? <Badge label="On sale" tone="success" /> : null}
          </View>
        </View>
        <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">{formatPaise(Math.round(item.price * 100))}</Text>
      </View>

      {inventory ? (
        <View className="flex-row items-center justify-between rounded-xl bg-surface2 px-3 py-2.5 dark:bg-surface2-dark">
          <View>
            <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">{available} available</Text>
            <Muted>
              {inventory.quantity} in stock · {inventory.reservedQuantity} reserved
            </Muted>
          </View>
          <Button label="Stock" variant="secondary" small icon={SlidersHorizontal} onPress={() => router.push('/(merchant)/inventory')} />
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 dark:border-line-dark">
          <Muted className="flex-1">No stock set yet</Muted>
          <Button label="Add stock" small icon={Plus} loading={isCreatingInventory} onPress={onAddInventory} />
        </View>
      )}

      <View className="flex-row gap-2">
        <Button
          label="Edit"
          variant="secondary"
          small
          icon={Pencil}
          onPress={() => router.push({ pathname: '/(merchant)/product-form', params: { productId: item.productId } })}
        />
        <Button label={item.isActive ? 'Hide' : 'Show'} variant="ghost" small icon={item.isActive ? EyeOff : Eye} loading={isToggling} onPress={onToggleVisible} />
      </View>
    </Card>
  );
}

export default function MerchantProductsScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantProducts);
  const [busyId, setBusyId] = useState<string | null>(null);
  useRefetchOnFocus(retry); // coming back from the form shows the new/edited product

  async function run(productId: string, action: () => Promise<unknown>) {
    setBusyId(productId);
    try {
      await action();
      retry();
    } catch (mutationError) {
      const { title, description } = describeError(mutationError);
      showAlert(title, description);
    } finally {
      setBusyId(null);
    }
  }

  const addProduct = <Button label="Add product" icon={Plus} onPress={() => router.push('/(merchant)/product-form')} />;

  if (isLoading && !data) return <LoadingState label="Loading products…" />;
  if (error && !data) return <ErrorState error={error} retry={retry} />;

  if (!data || data.length === 0) {
    return (
      <EmptyState title="No products yet" description="Add what you sell, with its price and stock. Customers see it as soon as your shop is open." icon={Package}>
        <View className="mt-2 w-full max-w-xs">{addProduct}</View>
      </EmptyState>
    );
  }

  return (
    <Canvas>
      <FlatList
        data={data}
        keyExtractor={(item) => item.productId}
        contentContainerClassName="gap-3 p-4"
        ListHeaderComponent={addProduct}
        renderItem={({ item }) => (
          <ProductRow
            item={item}
            isCreatingInventory={busyId === item.productId}
            isToggling={busyId === item.productId}
            onAddInventory={() => run(item.productId, () => createMerchantInventory(item.productId, 0))}
            onToggleVisible={() => run(item.productId, () => updateMerchantProduct(item.productId, { isAvailable: !item.isActive }))}
          />
        )}
      />
    </Canvas>
  );
}
