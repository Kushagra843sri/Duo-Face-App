import { useLocalSearchParams } from 'expo-router';
import { Ban, Minus, Pencil, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Modal, Text, TextInput, View } from 'react-native';

import {
  adjustMerchantInventory,
  disableMerchantInventory,
  getMerchantInventory,
  setMerchantInventoryQuantity,
} from '@/api/merchant';
import type { MerchantInventoryItem } from '@/api/merchant';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState, describeError } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Button, Canvas, Card, FilterChips, IconButton, Muted, usePalette } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { confirmAlert, showAlert } from '@/lib/alerts';
import { parseAdjustmentAmount } from '@/lib/inventoryValidation';

interface InventoryRowProps {
  item: MerchantInventoryItem;
  isMutating: boolean;
  onEdit: () => void;
  onAdjust: (delta: number) => void;
  onDisable: () => void;
}

function InventoryRow({ item, isMutating, onEdit, onAdjust, onDisable }: InventoryRowProps) {
  const [amountText, setAmountText] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const available = item.quantity - item.reservedQuantity;
  const disabled = item.status === 'disabled';

  function submitAdjust(sign: 1 | -1) {
    const amount = parseAdjustmentAmount(amountText);
    if (amount === null) {
      setAmountError('Enter a positive whole number.');
      return;
    }
    setAmountError(null);
    setAmountText('');
    onAdjust(sign * amount);
  }

  const palette = usePalette();
  const availableRatio = item.quantity > 0 ? Math.max(0, Math.min(1, available / item.quantity)) : 0;

  return (
    <Card className="gap-3">
      {/* The backend doesn't return a product name here — only productId.
          Shown as-is rather than joining against /merchant/products in an
          extra, unrequested fetch (see docs/decisions/012). */}
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 gap-1">
          <Text className="text-base font-bold text-ink dark:text-ink-dark" numberOfLines={1}>
            {item.productId}
          </Text>
          <Badge label={disabled ? 'Disabled' : 'Active'} tone={disabled ? 'neutral' : 'success'} />
        </View>
        <View className="items-end">
          <Text className="text-3xl font-extrabold text-ink dark:text-ink-dark">{available}</Text>
          <Muted>available</Muted>
        </View>
      </View>

      <View className="h-2 overflow-hidden rounded-full bg-surface2 dark:bg-surface2-dark">
        <View style={{ width: `${availableRatio * 100}%` }} className="h-2 rounded-full bg-emerald-500" />
      </View>
      <Muted>
        {item.quantity} qty · {item.reservedQuantity} reserved
      </Muted>

      {disabled ? null : (
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <IconButton icon={Minus} label="Decrease stock" disabled={isMutating} onPress={() => submitAdjust(-1)} />
            <TextInput
              editable={!isMutating}
              value={amountText}
              onChangeText={(text) => {
                setAmountText(text);
                setAmountError(null);
              }}
              keyboardType="number-pad"
              placeholder="Amount"
              placeholderTextColor={palette.muted}
              className="h-11 flex-1 rounded-xl border border-line bg-canvas px-3 text-center text-base font-semibold text-ink dark:border-line-dark dark:bg-canvas-dark dark:text-ink-dark"
            />
            <IconButton icon={Plus} label="Increase stock" disabled={isMutating} onPress={() => submitAdjust(1)} />
          </View>
          {amountError ? <Text className="text-xs font-medium text-red-600">{amountError}</Text> : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Edit quantity" variant="secondary" small icon={Pencil} disabled={isMutating} onPress={onEdit} fullWidth />
            </View>
            <IconButton icon={Ban} label="Disable inventory" tone="danger" disabled={isMutating} onPress={onDisable} />
          </View>
        </View>
      )}
    </Card>
  );
}

type InventoryFilter = 'all' | 'active' | 'disabled';

export default function MerchantInventoryScreen() {
  const { data, isLoading, error, retry } = useApiResource(getMerchantInventory);
  const params = useLocalSearchParams<{ filter?: string }>();
  const [picked, setPicked] = useState<InventoryFilter | null>(null);
  const filter: InventoryFilter = picked ?? (params.filter === 'active' || params.filter === 'disabled' ? params.filter : 'all');
  const [mutatingProductId, setMutatingProductId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<MerchantInventoryItem | null>(null);
  const [quantityText, setQuantityText] = useState('');
  const [quantityError, setQuantityError] = useState<string | null>(null);

  async function runMutation(productId: string, mutation: () => Promise<unknown>) {
    setMutatingProductId(productId);
    try {
      await mutation();
      retry();
    } catch (mutationError) {
      const { title, description } = describeError(mutationError);
      showAlert(title, description);
    } finally {
      setMutatingProductId(null);
    }
  }

  function openEditModal(item: MerchantInventoryItem) {
    setEditingItem(item);
    setQuantityText(String(item.quantity));
    setQuantityError(null);
  }

  async function submitQuantity() {
    if (!editingItem) return;
    const trimmed = quantityText.trim();
    if (!/^\d+$/.test(trimmed)) {
      setQuantityError('Enter a whole number of 0 or more.');
      return;
    }
    const quantity = Number.parseInt(trimmed, 10);
    const productId = editingItem.productId;
    setEditingItem(null);
    await runMutation(productId, () => setMerchantInventoryQuantity(productId, quantity));
  }

  function confirmDisable(item: MerchantInventoryItem) {
    confirmAlert({
      title: 'Disable inventory?',
      message: `This will stop tracking stock for ${item.productId}.`,
      confirmLabel: 'Disable',
      destructive: true,
      onConfirm: () => runMutation(item.productId, () => disableMerchantInventory(item.productId)),
    });
  }

  if (isLoading) {
    return <LoadingState label="Loading inventory…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No inventory yet" description="Nothing has been added to this shop's inventory." />;
  }

  return (
    <Canvas>
      <FilterChips
        value={filter}
        onChange={setPicked}
        options={[
          { value: 'all', label: 'All', count: data.length },
          { value: 'active', label: 'Active', count: data.filter((i) => i.status === 'active').length },
          { value: 'disabled', label: 'Disabled', count: data.filter((i) => i.status === 'disabled').length },
        ]}
      />
      <FlatList
        data={filter === 'all' ? data : data.filter((i) => i.status === filter)}
        ListEmptyComponent={<Muted className="p-6 text-center">Nothing here yet.</Muted>}
        keyExtractor={(item) => item.inventoryId}
        contentContainerClassName="gap-3 p-4"
        renderItem={({ item }) => (
          <InventoryRow
            item={item}
            isMutating={mutatingProductId === item.productId}
            onEdit={() => openEditModal(item)}
            onAdjust={(delta) => runMutation(item.productId, () => adjustMerchantInventory(item.productId, delta))}
            onDisable={() => confirmDisable(item)}
          />
        )}
      />

      <Modal visible={editingItem !== null} transparent animationType="fade" onRequestClose={() => setEditingItem(null)}>
        <View className="flex-1 items-center justify-end bg-black/50 p-4">
          <View className="w-full gap-4 rounded-3xl bg-surface p-5 dark:bg-surface-dark">
            <Text className="text-lg font-extrabold text-ink dark:text-ink-dark">Edit quantity</Text>
            <Muted>{editingItem?.productId}</Muted>
            <TextInput
              value={quantityText}
              onChangeText={(text) => {
                setQuantityText(text);
                setQuantityError(null);
              }}
              keyboardType="number-pad"
              autoFocus
              className="h-14 rounded-2xl border border-line bg-canvas px-4 text-center text-2xl font-extrabold text-ink dark:border-line-dark dark:bg-canvas-dark dark:text-ink-dark"
            />
            {quantityError ? <Text className="text-xs font-medium text-red-600">{quantityError}</Text> : null}
            <View className="gap-2">
              <Button label="Save" onPress={submitQuantity} />
              <Button label="Cancel" variant="ghost" onPress={() => setEditingItem(null)} />
            </View>
          </View>
        </View>
      </Modal>
    </Canvas>
  );
}
