import type { LucideIcon } from 'lucide-react-native';
import { ChevronRight } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ScrollViewProps, ViewProps } from 'react-native';

import { useAccentSoft, usePalette } from './theme';

/** Scrolling page on the themed canvas. Pass `footer` for a sticky action bar. */
export function Screen({
  children,
  footer,
  ...rest
}: { children: ReactNode; footer?: ReactNode } & Omit<ScrollViewProps, 'children'>) {
  return (
    <View className="flex-1 bg-canvas dark:bg-canvas-dark">
      <ScrollView className="flex-1" contentContainerClassName="gap-4 p-4 pb-8" {...rest}>
        {children}
      </ScrollView>
      {footer ? (
        <View className="gap-3 border-t border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">{footer}</View>
      ) : null}
    </View>
  );
}

/** Non-scrolling themed container (for screens that own a FlatList). */
export function Canvas({ children, className = '', ...rest }: ViewProps & { className?: string }) {
  return (
    <View className={`flex-1 bg-canvas dark:bg-canvas-dark ${className}`} {...rest}>
      {children}
    </View>
  );
}

export function Card({ children, className = '', ...rest }: ViewProps & { className?: string }) {
  return (
    <View
      className={`rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark ${className}`}
      {...rest}
    >
      {children}
    </View>
  );
}

/** A tappable card with a trailing chevron. */
export function PressableCard({
  children,
  onPress,
  accentEdge,
}: {
  children: ReactNode;
  onPress?: () => void;
  accentEdge?: boolean;
}) {
  const accent = useAccentSoft();
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}
    >
      <Card className="flex-row items-center gap-3" style={accentEdge ? { borderLeftWidth: 4, borderLeftColor: accent.fg } : undefined}>
        <View className="flex-1 gap-2">{children}</View>
        {onPress ? <ChevronRight size={20} color={palette.muted} /> : null}
      </Card>
    </Pressable>
  );
}

export function IconChip({ icon: Icon, size = 40 }: { icon: LucideIcon; size?: number }) {
  const soft = useAccentSoft();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3, backgroundColor: soft.bg }} className="items-center justify-center">
      <Icon size={size * 0.5} color={soft.fg} />
    </View>
  );
}

/** Titled card; replaces the five copy-pasted `Section` components. */
export function SectionCard({ title, icon: Icon, children }: { title: string; icon?: LucideIcon; children: ReactNode }) {
  const soft = useAccentSoft();
  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-2">
        {Icon ? <Icon size={16} color={soft.fg} /> : null}
        <Text className="text-xs font-bold uppercase tracking-wider text-muted dark:text-muted-dark">{title}</Text>
      </View>
      {children}
    </Card>
  );
}

export function InfoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Text className="text-sm text-muted dark:text-muted-dark">{label}</Text>
      <Text className={`flex-1 text-right ${strong ? 'text-base font-bold' : 'text-sm font-medium'} text-ink dark:text-ink-dark`}>{value}</Text>
    </View>
  );
}

export function Divider() {
  return <View className="h-px bg-line dark:bg-line-dark" />;
}

/** Body-text helper so screens don't repeat the colour pair. */
export function Muted({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Text className={`text-sm text-muted dark:text-muted-dark ${className}`}>{children}</Text>;
}
