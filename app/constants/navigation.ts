import { DarkTheme, DefaultTheme } from 'expo-router';

import { useAccent, useIsDark, usePalette } from '@/components/ui/theme';

/** Navigation container theme so headers/tab bars/screen backgrounds follow the system scheme. */
export function useNavTheme() {
  const dark = useIsDark();
  const palette = usePalette();
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      background: palette.canvas,
      card: palette.surface,
      text: palette.text,
      border: palette.line,
      primary: dark ? '#a5b4fc' : '#4f46e5',
    },
  };
}

/** Shared header look for every stack/tab header: flat, surface-coloured, bold title. */
export function useHeaderOptions() {
  const palette = usePalette();
  return {
    headerStyle: { backgroundColor: palette.surface },
    headerTintColor: palette.text,
    headerTitleStyle: { fontWeight: '800' as const, fontSize: 20, color: palette.text },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: palette.canvas },
  };
}

/** Tab bar: role-accent active tint, surface background, hairline top border. */
export function useTabOptions() {
  const accent = useAccent();
  const dark = useIsDark();
  const palette = usePalette();
  return {
    ...useHeaderOptions(),
    tabBarActiveTintColor: dark ? accent.onSoftDark : accent.solid,
    tabBarInactiveTintColor: palette.muted,
    tabBarLabelStyle: { fontSize: 11, fontWeight: '700' as const },
    tabBarStyle: {
      backgroundColor: palette.surface,
      borderTopColor: palette.line,
      borderTopWidth: 1,
      height: 64,
      paddingTop: 6,
      paddingBottom: 8,
    },
  };
}
