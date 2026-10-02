import { Stack } from 'expo-router';

import { useHeaderOptions } from '@/constants/navigation';

export default function MerchantDeliveriesLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="index" options={{ title: 'Deliveries' }} />
      <Stack.Screen name="[assignmentId]" options={{ title: 'Delivery' }} />
    </Stack>
  );
}
