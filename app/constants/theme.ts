export type Accent = {
  /** Solid fill for primary buttons, active icons. */
  solid: string;
  /** Darker shade for pressed state. */
  pressed: string;
  /** Soft tint background (light mode). */
  soft: string;
  /** Soft tint background (dark mode). */
  softDark: string;
  /** Text/icon colour on soft tint. */
  onSoft: string;
  onSoftDark: string;
};

/** Merchant = emerald, Driver = indigo. Same system, distinct identity. */
export const Accents: Record<'merchant' | 'driver', Accent> = {
  merchant: {
    solid: '#059669',
    pressed: '#047857',
    soft: '#d1fae5',
    softDark: '#0f3d2e',
    onSoft: '#047857',
    onSoftDark: '#6ee7b7',
  },
  driver: {
    solid: '#4f46e5',
    pressed: '#4338ca',
    soft: '#e0e7ff',
    softDark: '#26255a',
    onSoft: '#4338ca',
    onSoftDark: '#a5b4fc',
  },
};

export const Colors = {
  light: {
    canvas: '#f4f5f9',
    surface: '#ffffff',
    text: '#12141a',
    muted: '#5f6675',
    line: '#e3e6ee',
  },
  dark: {
    canvas: '#0f1115',
    surface: '#181b22',
    text: '#f3f4f8',
    muted: '#9aa1b2',
    line: '#2a2f3b',
  },
} as const;

export type Tone = 'success' | 'warn' | 'danger' | 'info' | 'neutral';

/** Status pill colours: bg/fg per scheme. Contrast checked against AA for 12-13px bold text. */
export const Tones: Record<Tone, { bg: string; fg: string; bgDark: string; fgDark: string }> = {
  success: { bg: '#dcfce7', fg: '#166534', bgDark: '#12351f', fgDark: '#86efac' },
  warn: { bg: '#fef3c7', fg: '#92400e', bgDark: '#3b2a0b', fgDark: '#fcd34d' },
  danger: { bg: '#fee2e2', fg: '#991b1b', bgDark: '#3d1515', fgDark: '#fca5a5' },
  info: { bg: '#dbeafe', fg: '#1e40af', bgDark: '#14284d', fgDark: '#93c5fd' },
  neutral: { bg: '#e5e7eb', fg: '#374151', bgDark: '#2a2f3b', fgDark: '#cbd0dc' },
};
