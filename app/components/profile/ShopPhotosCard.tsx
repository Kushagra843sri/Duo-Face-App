import { Image } from 'expo-image';
import { Camera, ImageIcon, Plus, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { getShopImages, removeShopImage } from '@/api/shopImages';
import type { ShopImages } from '@/api/shopImages';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Button, Muted, SectionCard, usePalette } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { pickAndUploadShopPhoto, ShopPhotoError } from '@/lib/shopPhotos';
import type { PhotoSource } from '@/lib/shopPhotos';

/**
 * Up to 4 storefront photos. Customers see these exact photos on the shop, so they can recognise
 * the shop by sight even if they forget its name. The first photo is the cover.
 */
export function ShopPhotosCard() {
  const palette = usePalette();
  const { data, isLoading, error, retry } = useApiResource(getShopImages);
  const [local, setLocal] = useState<ShopImages | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const current = local ?? data;

  async function run(action: () => Promise<ShopImages | null>) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await action();
      if (next) setLocal(next);
    } catch (err) {
      setMessage(err instanceof ShopPhotoError || err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (isLoading && !current) body = <LoadingState label="Loading your shop photos…" />;
  else if (error && !current) body = <ErrorState error={error} retry={retry} />;
  else if (current) {
    const full = current.images.length >= current.max;
    const add = (source: PhotoSource) => run(() => pickAndUploadShopPhoto(source));
    body = (
      <View className="gap-3">
        <Muted>
          Add up to {current.max} photos of your shop front. Customers see these on your shop, so they can spot it even if they forget the name. The first photo is the cover.
        </Muted>
        <View className="flex-row flex-wrap gap-3">
          {current.images.map((img, index) => (
            <View key={img.id} style={{ width: '47%', aspectRatio: 4 / 3 }} className="overflow-hidden rounded-2xl">
              <Image source={{ uri: img.url }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel={`Shop photo ${index + 1}`} />
              {index === 0 ? (
                <View className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5">
                  <Text className="text-xs font-semibold text-white">Cover</Text>
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove shop photo ${index + 1}`}
                disabled={busy}
                onPress={() => run(() => removeShopImage(img.id))}
                className="absolute right-2 top-2 h-8 w-8 items-center justify-center rounded-full bg-black/60"
              >
                <Trash2 size={16} color="#fff" />
              </Pressable>
            </View>
          ))}
          {!full ? (
            <View
              style={{ width: '47%', aspectRatio: 4 / 3, borderColor: palette.line }}
              className="items-center justify-center rounded-2xl border border-dashed bg-canvas dark:bg-canvas-dark"
            >
              <Plus size={28} color={palette.muted} />
            </View>
          ) : null}
        </View>
        {current.images.length === 0 ? <Muted>No photos yet. Shops with photos are much easier for customers to find.</Muted> : null}
        {!full ? (
          <View className="flex-row flex-wrap gap-2">
            <Button label="Take photo" icon={Camera} small variant="secondary" loading={busy} onPress={() => add('camera')} />
            <Button label="Choose from gallery" icon={ImageIcon} small variant="secondary" disabled={busy} onPress={() => add('library')} />
          </View>
        ) : (
          <Muted>You have added the maximum. Remove a photo to add a different one.</Muted>
        )}
        {message ? <Text className="text-sm font-medium text-red-600">{message}</Text> : null}
      </View>
    );
  }

  return (
    <SectionCard title="Shop photos" icon={Camera}>
      {body}
    </SectionCard>
  );
}
