import { ActivityIndicator, Text, View } from 'react-native';

interface Props {
  label?: string;
}

export function LoadingState({ label = 'Loading…' }: Props) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-white dark:bg-black">
      <ActivityIndicator />
      <Text className="text-sm text-neutral-500">{label}</Text>
    </View>
  );
}
