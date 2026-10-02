import { Text, TextInput, View } from 'react-native';
import type { KeyboardTypeOptions, TextInputProps } from 'react-native';

import { usePalette } from '@/components/ui';

interface Props {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
  /** Shown under the box. */
  hint?: string;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  maxLength?: number;
  /** A saved sensitive value, already masked by the server (e.g. "••••9012"). It is never editable. */
  savedMasked?: string | null;
  optional?: boolean;
}

/**
 * Labelled text input. Sensitive values (Aadhaar, PAN, account, licence) are
 * never shown after saving: the server returns them masked, they appear in
 * `savedMasked`, and typing a new value replaces them.
 */
export function Field({ label, value, onChangeText, error, hint, placeholder, keyboardType, autoCapitalize = 'sentences', maxLength, savedMasked, optional }: Props) {
  const palette = usePalette();
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-semibold text-ink dark:text-ink-dark">{label}</Text>
        {optional ? <Text className="text-xs text-muted dark:text-muted-dark">Optional</Text> : null}
      </View>
      {savedMasked ? <Text className="text-xs font-medium text-green-600">Saved: {savedMasked} · type below to replace</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.muted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        accessibilityLabel={label}
        style={error ? { borderColor: '#dc2626' } : undefined}
        className="h-12 rounded-xl border border-line bg-canvas px-3 text-base text-ink dark:border-line-dark dark:bg-canvas-dark dark:text-ink-dark"
      />
      {error ? <Text className="text-xs font-medium text-red-600">{error}</Text> : hint ? <Text className="text-xs text-muted dark:text-muted-dark">{hint}</Text> : null}
    </View>
  );
}
