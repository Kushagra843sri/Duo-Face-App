import { Stack } from 'expo-router';

import { useHeaderOptions } from '@/constants/navigation';

export default function DriverAssignmentsLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="index" options={{ title: 'Assignments' }} />
      <Stack.Screen name="[assignmentId]" options={{ title: 'Assignment' }} />
    </Stack>
  );
}
