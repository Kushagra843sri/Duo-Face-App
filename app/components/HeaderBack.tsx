import { router } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { usePalette } from '@/components/ui';

/** Back arrow for screens that live inside a tab navigator but are not tabs (e.g. Profile). */
export function HeaderBack({ fallback }: { fallback: string }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={10}
      onPress={() => (router.canGoBack() ? router.back() : router.replace(fallback as never))}
      style={{ paddingHorizontal: 16 }}
    >
      <ArrowLeft size={22} color={palette.text} />
    </Pressable>
  );
}
