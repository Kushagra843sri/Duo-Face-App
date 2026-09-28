import type { LucideIcon } from 'lucide-react-native';
import { CircleDashed } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

interface Props {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: ReactNode;
}

export function EmptyState({ title, description, icon: Icon = CircleDashed, children }: Props) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-white px-6 dark:bg-black">
      <Icon size={40} color="#9ca3af" />
      <Text className="text-center text-base font-semibold text-neutral-900 dark:text-neutral-50">
        {title}
      </Text>
      {description ? (
        <Text className="text-center text-sm text-neutral-500">{description}</Text>
      ) : null}
      {children}
    </View>
  );
}
