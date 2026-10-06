import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import { ApiError } from '@/api/client';
import { createMerchantProduct, getMerchantProducts, updateMerchantProduct } from '@/api/merchant';
import type { MerchantProductCatalogEntry } from '@/api/merchant';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Button, Muted, usePalette } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { parseRupeesToPaise } from '@/lib/money';

function describe(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Could not save the product. Please try again.';
}

/**
 * Loads the product being edited (if any), then shows the form starting from
 * its values: no effect copying state around, and the form is rebuilt if a
 * different product is opened.
 */
export default function ProductFormScreen() {
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const editing = typeof productId === 'string' && productId.length > 0;
  const catalog = useApiResource(() => (editing ? getMerchantProducts() : Promise.resolve(null)), [productId]);

  if (editing && catalog.isLoading) return <LoadingState label="Loading product…" />;
  if (editing && catalog.error) return <ErrorState error={catalog.error} retry={catalog.retry} />;
  const product = editing ? catalog.data?.find((p) => p.productId === productId) : undefined;
  if (editing && !product) return <ErrorState error={new Error('This product no longer exists.')} retry={() => router.back()} />;

  return <ProductForm key={productId ?? 'new'} productId={editing ? productId : undefined} initial={product} />;
}

/** Add a product (name, description, price, starting stock) or edit one (name, description, price, visibility). */
function ProductForm({ productId, initial }: { productId?: string; initial?: MerchantProductCatalogEntry }) {
  const editing = !!productId;
  const palette = usePalette();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [price, setPrice] = useState(initial ? String(initial.price) : '');
  const [stock, setStock] = useState('0');
  const [isAvailable, setIsAvailable] = useState(initial?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function save() {
    if (busy.current) return;
    const pricePaise = parseRupeesToPaise(price);
    const quantity = Number(stock);
    if (name.trim().length < 2) return setError('Give the product a name.');
    if (pricePaise === null || pricePaise < 100) return setError('Enter a price of at least ₹1, for example 28.50.');
    if (!editing && (!/^\d{1,6}$/.test(stock.trim()) || quantity > 100_000)) return setError('Enter the starting stock as a whole number.');

    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateMerchantProduct(productId!, { name: name.trim(), description: description.trim(), pricePaise, isAvailable });
      } else {
        await createMerchantProduct({ name: name.trim(), description: description.trim() || undefined, pricePaise, quantity });
      }
      router.back();
    } catch (err) {
      setError(describe(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const input =
    'rounded-2xl border border-line bg-surface px-4 text-base text-ink dark:border-line-dark dark:bg-surface-dark dark:text-ink-dark';

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 bg-canvas dark:bg-canvas-dark">
      <ScrollView contentContainerClassName="gap-4 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <View className="gap-2">
          <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Name</Text>
          <TextInput className={`${input} h-14`} placeholder="e.g. Toned Milk 500 ml" placeholderTextColor={palette.muted} value={name} onChangeText={setName} maxLength={80} />
        </View>
        <View className="gap-2">
          <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Description (optional)</Text>
          <TextInput
            className={`${input} min-h-24 py-3`}
            placeholder="Size, brand, anything a customer should know"
            placeholderTextColor={palette.muted}
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
            maxLength={300}
          />
        </View>
        <View className="gap-2">
          <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Price (₹)</Text>
          <TextInput className={`${input} h-14`} placeholder="28.50" placeholderTextColor={palette.muted} keyboardType="decimal-pad" value={price} onChangeText={setPrice} />
        </View>
        {editing ? (
          <>
            <View className="flex-row items-center justify-between gap-4">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Show to customers</Text>
                <Muted>Turn off to hide it without deleting it.</Muted>
              </View>
              <Switch value={isAvailable} onValueChange={setIsAvailable} />
            </View>
            <Muted>Change the quantity on the Inventory tab. A new price applies to new orders only.</Muted>
          </>
        ) : (
          <View className="gap-2">
            <Text className="text-sm font-semibold text-ink dark:text-ink-dark">Starting stock</Text>
            <TextInput className={`${input} h-14`} placeholder="10" placeholderTextColor={palette.muted} keyboardType="number-pad" value={stock} onChangeText={setStock} />
            <Muted>Customers can only order what is in stock.</Muted>
          </View>
        )}

        {error ? <Text className="text-sm font-medium text-red-600">{error}</Text> : null}
        <Button label={editing ? 'Save changes' : 'Add product'} loading={saving} onPress={save} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
