import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Clock, Package } from 'lucide-react-native';
import { FlatList, Text, View } from 'react-native';

import { getDriverAssignments } from '@/api/driver';
import type { DriverAssignment } from '@/api/driver';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { Canvas, FilterChips, PressableCard, StatusBadge, useAccentSoft } from '@/components/ui';
import { useApiResource } from '@/hooks/useApiResource';

const ACTIVE_STATUSES = ['assigned', 'accepted', 'picked_up'];

type Filter = 'all' | 'active' | 'completed';

function matches(filter: Filter, status: string): boolean {
  if (filter === 'active') return ACTIVE_STATUSES.includes(status);
  if (filter === 'completed') return status === 'delivered';
  return true;
}

/** The most relevant lifecycle timestamp for the assignment's current status. */
function mostRecentTimestamp(assignment: DriverAssignment): string {
  switch (assignment.status) {
    case 'accepted':
      return assignment.acceptedAt ?? assignment.assignedAt;
    case 'rejected':
      return assignment.rejectedAt ?? assignment.assignedAt;
    case 'picked_up':
      return assignment.pickedUpAt ?? assignment.assignedAt;
    case 'delivered':
      return assignment.deliveredAt ?? assignment.assignedAt;
    default:
      return assignment.assignedAt;
  }
}

function AssignmentRow({ assignment }: { assignment: DriverAssignment }) {
  const soft = useAccentSoft();
  return (
    <PressableCard
      accentEdge={ACTIVE_STATUSES.includes(assignment.status)}
      onPress={() => router.push(`/(driver)/assignments/${assignment.assignmentId}`)}
    >
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Package size={18} color={soft.fg} />
          <Text className="text-base font-bold text-ink dark:text-ink-dark">Order {assignment.orderId}</Text>
        </View>
        <StatusBadge status={assignment.status} kind="assignment" />
      </View>
      <View className="flex-row items-center gap-1.5">
        <Clock size={14} color="#9ca3af" />
        <Text className="text-sm text-muted dark:text-muted-dark">{new Date(mostRecentTimestamp(assignment)).toLocaleString()}</Text>
      </View>
    </PressableCard>
  );
}

export default function DriverAssignmentsScreen() {
  const { data, isLoading, error, retry } = useApiResource(getDriverAssignments);
  const params = useLocalSearchParams<{ filter?: string }>();
  // The dashboard cards link here with ?filter=...; the chips then own the state.
  const [picked, setPicked] = useState<Filter | null>(null);
  const filter: Filter = picked ?? (params.filter === 'active' || params.filter === 'completed' ? params.filter : 'all');

  if (isLoading) {
    return <LoadingState label="Loading assignments…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (!data || data.length === 0) {
    return <EmptyState title="No assignments yet" description="Orders assigned to you will show up here." />;
  }

  const visible = data.filter((a) => matches(filter, a.status));

  return (
    <Canvas>
      <FilterChips
        value={filter}
        onChange={setPicked}
        options={[
          { value: 'all', label: 'All', count: data.length },
          { value: 'active', label: 'Active', count: data.filter((a) => matches('active', a.status)).length },
          { value: 'completed', label: 'Completed', count: data.filter((a) => matches('completed', a.status)).length },
        ]}
      />
      <FlatList
        data={visible}
        keyExtractor={(item) => item.assignmentId}
        contentContainerClassName="gap-3 p-4"
        ListEmptyComponent={<Text className="p-6 text-center text-sm text-muted dark:text-muted-dark">Nothing here yet.</Text>}
        renderItem={({ item }) => <AssignmentRow assignment={item} />}
      />
    </Canvas>
  );
}
