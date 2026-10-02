import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { Accents, Colors } from '@/constants/theme';
import type { Accent } from '@/constants/theme';

const AccentContext = createContext<Accent>(Accents.merchant);

/** Wraps a role's route group so every shared component picks up that role's accent. */
export function AccentProvider({ role, children }: { role: keyof typeof Accents; children: ReactNode }) {
  return <AccentContext.Provider value={Accents[role]}>{children}</AccentContext.Provider>;
}

export function useAccent(): Accent {
  return useContext(AccentContext);
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark';
}

/** Raw hex palette for the current scheme (icons, nav theme, anything className can't reach). */
export function usePalette() {
  return useIsDark() ? Colors.dark : Colors.light;
}

/** The accent's soft-tint background and its foreground, resolved for the current scheme. */
export function useAccentSoft(): { bg: string; fg: string } {
  const accent = useAccent();
  const dark = useIsDark();
  return { bg: dark ? accent.softDark : accent.soft, fg: dark ? accent.onSoftDark : accent.onSoft };
}
