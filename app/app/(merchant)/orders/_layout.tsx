import { Stack } from 'expo-router';

import { useHeaderOptions } from '@/constants/navigation';

export default function MerchantOrdersLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="index" options={{ title: 'Orders' }} />
      <Stack.Screen name="[orderId]" options={{ title: 'Order' }} />
    </Stack>
  );
}
