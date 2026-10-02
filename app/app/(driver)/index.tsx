import { router } from 'expo-router';
import { CircleCheck, ClipboardList, Truck } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { getDriverAssignments, getDriverMe } from '@/api/driver';
import { DutyCard } from '@/components/DutyCard';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { HeroHeader, PressableCard, Screen, StatCard, StatusBadge } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';

const ACTIVE_STATUSES = ['assigned', 'accepted', 'picked_up'];

interface DashboardData {
  name: string;
  phoneNumber?: string;
  totalCount: number;
  activeCount: number;
  completedCount: number;
  /** The most recent not-yet-finished assignment, for the "Current delivery" shortcut. */
  current?: { assignmentId: string; orderId: string; status: string };
}

async function loadDashboard(): Promise<DashboardData> {
  const [me, assignments] = await Promise.all([getDriverMe(), getDriverAssignments()]);
  const current = assignments.find((a) => ACTIVE_STATUSES.includes(a.status));

  return {
    name: me.name,
    phoneNumber: me.phoneNumber,
    totalCount: assignments.length,
    activeCount: assignments.filter((a) => ACTIVE_STATUSES.includes(a.status)).length,
    completedCount: assignments.filter((a) => a.status === 'delivered').length,
    current: current ? { assignmentId: current.assignmentId, orderId: current.orderId, status: current.status } : undefined,
  };
}

/** Opens the Assignments tab pre-filtered (the dashboard numbers are shortcuts, not dead ends). */
function openAssignments(filter: 'all' | 'active' | 'completed') {
  router.navigate({ pathname: '/(driver)/assignments', params: { filter } });
}

export default function DriverDashboard() {
  const { data, isLoading, error, retry } = useApiResource(loadDashboard);

  if (isLoading) {
    return <LoadingState label="Loading dashboard…" />;
  }

  if (error || !data) {
    return <ErrorState error={error} retry={retry} />;
  }

  return (
    <Screen>
      <HeroHeader eyebrow="Delivery partner" title={data.name} subtitle={data.phoneNumber} actionLabel="View & edit profile" onPress={() => router.push('/(driver)/profile' as never)} />

      <DutyCard />

      <View className="flex-row gap-3">
        <StatCard label="Active" value={data.activeCount} icon={Truck} onPress={() => openAssignments('active')} />
        <StatCard label="Completed" value={data.completedCount} icon={CircleCheck} onPress={() => openAssignments('completed')} />
        <StatCard label="Total" value={data.totalCount} icon={ClipboardList} onPress={() => openAssignments('all')} />
      </View>

      <Text className="mt-2 text-xs font-bold uppercase tracking-wider text-muted dark:text-muted-dark">Current delivery</Text>
      {data.current ? (
        <PressableCard accentEdge onPress={() => router.push(`/(driver)/assignments/${data.current?.assignmentId}`)}>
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-bold text-ink dark:text-ink-dark">Order {data.current.orderId}</Text>
            <StatusBadge status={data.current.status} kind="assignment" />
          </View>
          <Text className="text-sm text-muted dark:text-muted-dark">Tap to continue this delivery</Text>
        </PressableCard>
      ) : (
        <View className="rounded-2xl border border-dashed border-line p-5 dark:border-line-dark">
          <Text className="text-center text-sm text-muted dark:text-muted-dark">No active delivery right now. New orders will appear here.</Text>
        </View>
      )}
    </Screen>
  );
}
