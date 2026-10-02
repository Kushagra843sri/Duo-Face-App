import { Pressable, Text, View } from 'react-native';

import { useAccent, useAccentSoft, usePalette } from './theme';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** Single-select filter row (e.g. All / Active / Completed). */
export function FilterChips<T extends string>({ options, value, onChange, flush }: { options: ChipOption<T>[]; value: T; onChange: (next: T) => void; flush?: boolean }) {
  const accent = useAccent();
  const soft = useAccentSoft();
  const palette = usePalette();
  return (
    <View className={flush ? 'flex-row flex-wrap gap-2' : 'flex-row gap-2 px-4 pb-1 pt-3'}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={{ backgroundColor: selected ? accent.solid : soft.bg, borderColor: selected ? accent.solid : palette.line }}
            className="min-h-[36px] flex-row items-center gap-1.5 rounded-full border px-4 py-1.5"
          >
            <Text style={{ color: selected ? '#ffffff' : soft.fg }} className="text-sm font-bold">
              {option.label}
              {option.count !== undefined ? ` · ${option.count}` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
