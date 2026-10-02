import { ActivityIndicator, Text, View } from 'react-native';

import { useAccentSoft } from '@/components/ui';

interface Props {
  label?: string;
}

export function LoadingState({ label = 'Loading…' }: Props) {
  const accent = useAccentSoft();
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-canvas dark:bg-canvas-dark">
      <View style={{ backgroundColor: accent.bg }} className="h-16 w-16 items-center justify-center rounded-full">
        <ActivityIndicator color={accent.fg} />
      </View>
      <Text className="text-sm font-medium text-muted dark:text-muted-dark">{label}</Text>
    </View>
  );
}
