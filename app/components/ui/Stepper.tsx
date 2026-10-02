import { Check } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { useAccent, usePalette } from './theme';

export interface Step {
  label: string;
  /** Optional secondary line (e.g. a timestamp). */
  detail?: string;
  done: boolean;
}

/** Vertical timeline: filled dot + connector for completed steps. */
export function VerticalSteps({ steps }: { steps: Step[] }) {
  const accent = useAccent();
  const palette = usePalette();
  return (
    <View>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <View key={step.label} className="flex-row gap-3">
            <View className="items-center">
              <View
                style={{ backgroundColor: step.done ? accent.solid : 'transparent', borderColor: step.done ? accent.solid : palette.line }}
                className="h-6 w-6 items-center justify-center rounded-full border-2"
              >
                {step.done ? <Check size={14} color="#ffffff" strokeWidth={3} /> : null}
              </View>
              {!last ? <View style={{ backgroundColor: step.done ? accent.solid : palette.line }} className="my-1 w-0.5 flex-1" /> : null}
            </View>
            <View className={`flex-1 ${last ? '' : 'pb-4'}`}>
              <Text className={`text-sm font-semibold ${step.done ? 'text-ink dark:text-ink-dark' : 'text-muted dark:text-muted-dark'}`}>
                {step.label}
              </Text>
              {step.detail ? <Text className="text-xs text-muted dark:text-muted-dark">{step.detail}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Compact horizontal progress for a delivery's happy path. */
export function HorizontalProgress({ labels, activeIndex }: { labels: string[]; activeIndex: number }) {
  const accent = useAccent();
  const palette = usePalette();
  return (
    <View className="flex-row items-start">
      {labels.map((label, index) => {
        const done = index <= activeIndex;
        const first = index === 0;
        const last = index === labels.length - 1;
        return (
          <View key={label} className="flex-1 items-center gap-1">
            <View className="w-full flex-row items-center">
              <View style={{ backgroundColor: first ? 'transparent' : done ? accent.solid : palette.line }} className="h-0.5 flex-1" />
              <View
                style={{ backgroundColor: done ? accent.solid : palette.surface, borderColor: done ? accent.solid : palette.line }}
                className="h-5 w-5 items-center justify-center rounded-full border-2"
              >
                {done ? <Check size={11} color="#ffffff" strokeWidth={3} /> : null}
              </View>
              <View style={{ backgroundColor: last ? 'transparent' : index < activeIndex ? accent.solid : palette.line }} className="h-0.5 flex-1" />
            </View>
            <Text className={`text-center text-[11px] font-semibold ${done ? 'text-ink dark:text-ink-dark' : 'text-muted dark:text-muted-dark'}`} numberOfLines={1}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
