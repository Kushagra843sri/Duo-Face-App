import type { LucideIcon } from 'lucide-react-native';
import { Ban, CircleCheck, CircleX, Clock, PackageCheck, Truck, UserCheck } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Tones } from '@/constants/theme';
import type { Tone } from '@/constants/theme';
import { formatAssignmentStatus } from '@/lib/assignmentStatus';
import { formatOrderStatus } from '@/lib/orderStatus';

import { Card, IconChip } from './Layout';
import { useAccentSoft, useIsDark } from './theme';

export function Badge({ label, tone = 'neutral', icon: Icon }: { label: string; tone?: Tone; icon?: LucideIcon }) {
  const dark = useIsDark();
  const t = Tones[tone];
  const fg = dark ? t.fgDark : t.fg;
  return (
    <View style={{ backgroundColor: dark ? t.bgDark : t.bg }} className="flex-row items-center gap-1 self-start rounded-full px-2.5 py-1">
      {Icon ? <Icon size={12} color={fg} /> : null}
      <Text style={{ color: fg }} className="text-xs font-bold">
        {label}
      </Text>
    </View>
  );
}

const STATUS_STYLE: Record<string, { tone: Tone; icon: LucideIcon }> = {
  // order statuses
  pending: { tone: 'warn', icon: Clock },
  confirmed: { tone: 'info', icon: CircleCheck },
  preparing: { tone: 'info', icon: PackageCheck },
  ready_for_pickup: { tone: 'info', icon: PackageCheck },
  out_for_delivery: { tone: 'info', icon: Truck },
  delivered: { tone: 'success', icon: CircleCheck },
  cancelled: { tone: 'danger', icon: Ban },
  rejected: { tone: 'danger', icon: CircleX },
  // assignment statuses
  assigned: { tone: 'warn', icon: Clock },
  accepted: { tone: 'info', icon: UserCheck },
  picked_up: { tone: 'info', icon: Truck },
};

/** `kind` selects which existing label formatter is used; colours are shared. */
export function StatusBadge({ status, kind }: { status: string; kind: 'order' | 'assignment' }) {
  const style = STATUS_STYLE[status] ?? { tone: 'neutral' as Tone, icon: Clock };
  const label = kind === 'order' ? formatOrderStatus(status) : formatAssignmentStatus(status);
  return <Badge label={label} tone={style.tone} icon={style.icon} />;
}

export function StatCard({ label, value, icon, onPress }: { label: string; value: number | string; icon: LucideIcon; onPress?: () => void }) {
  const card = (
    <Card className="flex-1 gap-3 p-3">
      <IconChip icon={icon} size={36} />
      <View>
        <Text className="text-3xl font-extrabold text-ink dark:text-ink-dark">{value}</Text>
        <Text className="text-xs font-medium text-muted dark:text-muted-dark" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Card>
  );
  if (!onPress) return card;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      {card}
    </Pressable>
  );
}

/** Circular initial, e.g. driver avatar. */
export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const soft = useAccentSoft();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: soft.bg }} className="items-center justify-center">
      <Text style={{ color: soft.fg, fontSize: size * 0.42 }} className="font-extrabold">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}
