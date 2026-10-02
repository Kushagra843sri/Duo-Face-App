import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { useAccent, useAccentSoft, usePalette } from './theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
  /** Compact inline button (e.g. inside a list card). */
  small?: boolean;
  /** Stretch to the container width. Default true unless `small`. */
  fullWidth?: boolean;
}

const DANGER = '#dc2626';
const DANGER_PRESSED = '#b91c1c';

export function Button({ label, onPress, variant = 'primary', icon: Icon, disabled, loading, small, fullWidth }: Props) {
  const accent = useAccent();
  const soft = useAccentSoft();
  const palette = usePalette();
  const inactive = disabled || loading;

  const colors = (pressed: boolean) => {
    switch (variant) {
      case 'primary':
        return { bg: pressed ? accent.pressed : accent.solid, fg: '#ffffff' };
      case 'danger':
        return { bg: pressed ? DANGER_PRESSED : DANGER, fg: '#ffffff' };
      case 'secondary':
        return { bg: pressed ? palette.line : soft.bg, fg: soft.fg };
      default:
        return { bg: pressed ? palette.line : 'transparent', fg: soft.fg };
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={{ alignSelf: (fullWidth ?? !small) ? 'stretch' : 'flex-start' }}
    >
      {({ pressed }) => {
        const { bg, fg } = colors(pressed);
        return (
          <View
            style={{
              backgroundColor: bg,
              opacity: inactive ? 0.5 : 1,
              minHeight: small ? 40 : 52,
              paddingHorizontal: small ? 14 : 20,
              borderRadius: small ? 12 : 16,
              justifyContent: 'center',
              alignItems: 'center',
              flexDirection: 'row',
              gap: 8,
            }}
          >
            {loading ? <ActivityIndicator size="small" color={fg} /> : Icon ? <Icon size={small ? 16 : 20} color={fg} /> : null}
            <Text style={{ color: fg, fontSize: small ? 14 : 16, fontWeight: small ? '600' : '700' }}>{label}</Text>
          </View>
        );
      }}
    </Pressable>
  );
}

/** Round-cornered icon-only button (edit, disable, +/-). 44px touch target. */
export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled,
  tone = 'accent',
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'accent' | 'danger';
}) {
  const soft = useAccentSoft();
  const palette = usePalette();
  const fg = tone === 'danger' ? DANGER : soft.fg;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={4}>
      {({ pressed }) => (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? palette.line : tone === 'danger' ? 'transparent' : soft.bg,
            borderWidth: tone === 'danger' ? 1 : 0,
            borderColor: palette.line,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Icon size={20} color={fg} />
        </View>
      )}
    </Pressable>
  );
}
