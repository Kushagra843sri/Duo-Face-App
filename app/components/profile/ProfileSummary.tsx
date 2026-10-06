import { Image } from 'expo-image';
import { Check, Circle } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { Completeness, VerificationStatus } from '@/api/profile';
import { Badge, Card, useAccent, useAccentSoft, usePalette } from '@/components/ui';
import type { Tone } from '@/constants/theme';

const STATUS: Record<VerificationStatus, { label: string; tone: Tone }> = {
  incomplete: { label: 'Incomplete', tone: 'neutral' },
  pending_review: { label: 'Under review', tone: 'warn' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Needs changes', tone: 'danger' },
};

/** Profile photo, or a blank coloured circle with the initial (like WhatsApp) when there is none. */
export function ProfileAvatar({ name, uri, size = 72 }: { name: string; uri?: string | null; size?: number }) {
  const soft = useAccentSoft();
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} contentFit="cover" accessibilityLabel="Profile photo" />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: soft.bg }} className="items-center justify-center">
      <Text style={{ color: soft.fg, fontSize: size * 0.42 }} className="font-extrabold">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}

interface Props {
  name: string;
  subtitle?: string;
  photoUri?: string | null;
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  /** The reviewer's reason while a section is rejected, so the person knows what to fix. */
  kycNote?: string | null;
  bankNote?: string | null;
  completeness: Completeness;
}

/** Top of the profile: who you are, review status, and what is still missing. */
export function ProfileSummary({ name, subtitle, photoUri, kycStatus, bankStatus, kycNote, bankNote, completeness }: Props) {
  const accent = useAccent();
  const palette = usePalette();
  const ratio = completeness.total > 0 ? completeness.completed / completeness.total : 0;

  return (
    <Card className="gap-4">
      <View className="flex-row items-center gap-4">
        <ProfileAvatar name={name} uri={photoUri} />
        <View className="flex-1 gap-1">
          <Text className="text-xl font-extrabold text-ink dark:text-ink-dark" numberOfLines={1}>
            {name}
          </Text>
          {subtitle ? (
            <Text className="text-sm text-muted dark:text-muted-dark" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <Badge label={`KYC: ${STATUS[kycStatus].label}`} tone={STATUS[kycStatus].tone} />
        <Badge label={`Bank: ${STATUS[bankStatus].label}`} tone={STATUS[bankStatus].tone} />
      </View>

      {kycStatus === 'rejected' || bankStatus === 'rejected' ? (
        <View className="gap-1 rounded-2xl bg-red-50 p-3 dark:bg-red-950">
          {kycStatus === 'rejected' ? (
            <Text className="text-sm text-red-800 dark:text-red-200">
              <Text className="font-bold">KYC needs changes: </Text>
              {kycNote ?? 'Please review your details and save again.'}
            </Text>
          ) : null}
          {bankStatus === 'rejected' ? (
            <Text className="text-sm text-red-800 dark:text-red-200">
              <Text className="font-bold">Bank needs changes: </Text>
              {bankNote ?? 'Please review your bank details and save again.'}
            </Text>
          ) : null}
          <Text className="text-xs text-red-700 dark:text-red-300">Update the details below and save: they go back for review.</Text>
        </View>
      ) : null}

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-bold text-ink dark:text-ink-dark">Profile completeness</Text>
          <Text className="text-sm font-semibold text-muted dark:text-muted-dark">
            {completeness.completed} of {completeness.total}
          </Text>
        </View>
        <View style={{ backgroundColor: palette.line }} className="h-2 overflow-hidden rounded-full">
          <View style={{ width: `${ratio * 100}%`, backgroundColor: accent.solid }} className="h-2 rounded-full" />
        </View>
        <View className="gap-1.5">
          {completeness.sections.map((section) => (
            <View key={section.key} className="flex-row items-center gap-2">
              {section.done ? <Check size={14} color="#16a34a" strokeWidth={3} /> : <Circle size={14} color={palette.muted} />}
              <Text className={`text-sm ${section.done ? 'text-ink dark:text-ink-dark' : 'text-muted dark:text-muted-dark'}`}>
                {section.label}
                {section.optional ? ' (optional)' : ''}
              </Text>
            </View>
          ))}
        </View>
        {kycStatus === 'pending_review' || bankStatus === 'pending_review' ? (
          <Text className="text-xs text-muted dark:text-muted-dark">Your details are with our team. Payouts start once both KYC and bank are verified.</Text>
        ) : null}
      </View>
    </Card>
  );
}
