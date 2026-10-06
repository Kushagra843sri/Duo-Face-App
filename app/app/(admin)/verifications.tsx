import { useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { listVerifications } from '@/api/admin';
import type { VerificationQueueItem } from '@/api/admin';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Badge, Canvas, Muted, PressableCard } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';

const SECTION_LABEL = { kyc: 'KYC', bank: 'Bank' } as const;

function QueueCard({ item, onPress }: { item: VerificationQueueItem; onPress: () => void }) {
  return (
    <PressableCard onPress={onPress} accentEdge>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-bold text-ink dark:text-ink-dark" numberOfLines={1}>
          {item.name || (item.kind === 'driver' ? 'Driver' : 'Shop')}
        </Text>
        <Badge label={item.kind === 'driver' ? 'Driver' : 'Shop'} tone="info" />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        {item.pending.map((section) => (
          <Badge key={section} label={`${SECTION_LABEL[section]} to review`} tone="warn" />
        ))}
      </View>
      {item.submittedAt ? <Muted>Submitted {new Date(item.submittedAt).toLocaleString()}</Muted> : null}
    </PressableCard>
  );
}

export default function VerificationsScreen() {
  const router = useRouter();
  const { data, isLoading, error, retry } = useApiResource(listVerifications);
  useRefetchOnFocus(retry);

  if (isLoading && !data) return <LoadingState label="Loading reviews…" />;
  if (error && !data) return <ErrorState error={error} retry={retry} forbiddenMessage="Your account is not authorized as an admin." />;
  if (!data) return null;

  if (data.length === 0) {
    return <EmptyState title="Nothing to review" description="Drivers and shops waiting for verification will appear here, oldest first." icon={ShieldCheck} />;
  }

  return (
    <Canvas>
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" refreshControl={<RefreshControl refreshing={isLoading} onRefresh={retry} />}>
        <Muted>{data.length} waiting, oldest first.</Muted>
        {data.map((item) => (
          <QueueCard
            key={`${item.kind}:${item.ownerId}`}
            item={item}
            onPress={() => router.push({ pathname: '/(admin)/review/[kind]/[ownerId]', params: { kind: item.kind, ownerId: item.ownerId } })}
          />
        ))}
      </ScrollView>
    </Canvas>
  );
}
