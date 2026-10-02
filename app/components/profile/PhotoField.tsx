import { Image } from 'expo-image';
import { Camera, ImageIcon, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { removeProfilePhoto } from '@/api/profile';
import type { PhotoKind } from '@/api/profile';
import { Button, Muted, usePalette } from '@/components/ui';
import { captureAndUpload, PhotoError } from '@/lib/profilePhotos';

interface Props {
  role: 'driver' | 'merchant';
  kind: PhotoKind;
  label: string;
  hint: string;
  uri: string | null;
  /** True = camera only (no gallery path exists in the UI or the code for this kind). */
  cameraOnly: boolean;
  removable?: boolean;
  /** Called after the server has the new photo (or it was removed), to reload the profile. */
  onChanged: () => void;
}

/** One photo slot. Live photos (selfie, vehicle) can only be taken with the camera. */
export function PhotoField({ role, kind, label, hint, uri, cameraOnly, removable, onChanged }: Props) {
  const palette = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<boolean | void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const changed = await action();
      if (changed !== false) onChanged();
    } catch (err) {
      setError(err instanceof PhotoError || err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-2">
      <Text className="text-sm font-semibold text-ink dark:text-ink-dark">{label}</Text>
      <Muted>{hint}</Muted>
      <View style={{ borderColor: palette.line }} className="h-44 items-center justify-center overflow-hidden rounded-2xl border border-dashed bg-canvas dark:bg-canvas-dark">
        {uri ? (
          <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" accessibilityLabel={label} />
        ) : (
          <Camera size={32} color={palette.muted} />
        )}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button label={uri ? 'Retake photo' : 'Take photo'} icon={Camera} small variant="secondary" loading={busy} onPress={() => run(() => captureAndUpload(role, kind, 'camera'))} />
        {!cameraOnly ? (
          <Button label="Choose from gallery" icon={ImageIcon} small variant="secondary" disabled={busy} onPress={() => run(() => captureAndUpload(role, kind, 'library'))} />
        ) : null}
        {removable && uri ? (
          <Button
            label="Remove"
            icon={Trash2}
            small
            variant="ghost"
            disabled={busy}
            onPress={() =>
              run(async () => {
                await removeProfilePhoto(role, kind);
              })
            }
          />
        ) : null}
      </View>
      {error ? <Text className="text-sm font-medium text-red-600">{error}</Text> : null}
    </View>
  );
}
