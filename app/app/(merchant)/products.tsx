import { router } from 'expo-router';
import { Package, Plus, SlidersHorizontal } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';

import { createMerchantInventory, getMerchantProducts } from '@/api/merchant';
import type { MerchantProductCatalogEntry } from '@/api/merchant';
import { EmptyState } from '@/components/EmptyState';
import { describeError, ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Button, Canvas, Card, IconChip, Muted } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { showAlert } from '@/lib/alerts';

interface ProductRowProps {
  item: MerchantProductCatalogEntry;
  isCreatingInventory: boolean;
  onAddInventory: () => void;
}

function ProductRow({ item, isCreatingInventory, onAddInventory }: ProductRowProps) {
  const inventory = item.inventory;
  const available = inventory ? inventory.quantity - inventory.reservedQuantity : 0;

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <IconChip icon={Package} />
        <View className="flex-1 gap-1">
          <Text className="text-base font-bold text-ink dark:text-ink-dark" numberOfLines={2}>
            {item.name}
          </Text>
          <Badge label={item.inStock ? 'In stock' : 'Out of stock'} tone={item.inStock ? 'success' : 'danger'} />
        </View>
        <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">₹{item.price}</Text>
      </View>

      {inventory ? (
        <View className="flex-row items-center justify-between rounded-xl bg-surface2 px-3 py-2.5 dark:bg-surface2-dark">
          <View>
            <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">{available} available</Text>
            <Muted>
              {inventory.quantity} qty · {inventory.reservedQuantity} reserved · {inventory.status}
            </Muted>
          </View>
          <Button label="Manage" variant="secondary" small icon={SlidersHorizontal} onPress={() => router.push('/(merchant)/inventory')} />
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 dark:border-line-dark">
          <Muted className="flex-1">Inventory not configured</Muted>
          <Button label="Add inventory" small icon={Plus} loading={isCreatingInventory} onPress={onAddInventory} />
        </View>
      )}
    </Card>
  );
}

export default function MerchantProductsScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantProducts);
  const [creatingProductId, setCreatingProductId] = useState<string | null>(null);

  async function addInventory(productId: string) {
    setCreatingProductId(productId);
    try {
      await createMerchantInventory(productId, 0);
      retry();
    } catch (mutationError) {
      const { title, description } = describeError(mutationError);
      showAlert(title, description);
    } finally {
      setCreatingProductId(null);
    }
  }

  if (isLoading) {
    return <LoadingState label="Loading products…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No products yet" description="This shop's catalog is empty." icon={Package} />;
  }

  return (
    <Canvas>
      <FlatList
        data={data}
        keyExtractor={(item) => item.productId}
        contentContainerClassName="gap-3 p-4"
        renderItem={({ item }) => (
          <ProductRow
            item={item}
            isCreatingInventory={creatingProductId === item.productId}
            onAddInventory={() => addInventory(item.productId)}
          />
        )}
      />
    </Canvas>
  );
}
