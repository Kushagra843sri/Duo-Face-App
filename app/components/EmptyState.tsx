import type { LucideIcon } from 'lucide-react-native';
import { Inbox } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { IconChip } from '@/components/ui';

interface Props {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: ReactNode;
}

export function EmptyState({ title, description, icon = Inbox, children }: Props) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-canvas px-8 dark:bg-canvas-dark">
      <IconChip icon={icon} size={72} />
      <Text className="text-center text-lg font-bold text-ink dark:text-ink-dark">{title}</Text>
      {description ? <Text className="text-center text-sm text-muted dark:text-muted-dark">{description}</Text> : null}
      {children}
    </View>
  );
}
