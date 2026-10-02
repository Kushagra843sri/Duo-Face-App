import { ChevronRight } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { useAccent } from './theme';

interface Props {
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Makes the header tappable (opens the profile) and shows a chevron. */
  onPress?: () => void;
  /** Tiny hint under the subtitle when tappable, e.g. "View profile". */
  actionLabel?: string;
}

/** Branded greeting block for the dashboards. Solid accent fill (no gradient dependency). */
export function HeroHeader({ eyebrow, title, subtitle, onPress, actionLabel }: Props) {
  const accent = useAccent();
  const initial = title.trim().charAt(0).toUpperCase() || '?';
  const content = (
    <View style={{ backgroundColor: accent.solid }} className="flex-row items-center gap-4 overflow-hidden rounded-3xl p-5">
      <View className="absolute -right-8 -top-10 h-36 w-36 rounded-full bg-white/10" />
      <View className="absolute -bottom-12 right-10 h-24 w-24 rounded-full bg-white/10" />
      <View className="h-14 w-14 items-center justify-center rounded-full bg-white/20">
        <Text className="text-2xl font-extrabold text-white">{initial}</Text>
      </View>
      <View className="flex-1">
        <Text className="text-xs font-semibold uppercase tracking-wider text-white/80">{eyebrow}</Text>
        <Text className="text-xl font-extrabold text-white" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-sm text-white/85" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {onPress && actionLabel ? <Text className="mt-0.5 text-xs font-bold text-white underline">{actionLabel}</Text> : null}
      </View>
      {onPress ? <ChevronRight size={22} color="#ffffff" /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${actionLabel ?? 'Open profile'}`} style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}>
      {content}
    </Pressable>
  );
}
