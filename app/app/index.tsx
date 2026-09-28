import { Link, Redirect } from 'expo-router';
import { View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { useRole } from '@/hooks/useRole';

export default function Index() {
  const { role, isLoading } = useRole();

  if (isLoading) {
    return <LoadingState label="Resolving your role…" />;
  }

  if (role === 'merchant') {
    return <Redirect href="/(merchant)" />;
  }

  if (role === 'driver') {
    return <Redirect href="/(driver)" />;
  }

  return (
    <EmptyState
      title="Role resolution pending"
      description="Authentication isn't implemented yet (Phase 2). Use the links below for manual QA of the route groups."
    >
      <View className="mt-2 gap-2">
        <Link href="/(merchant)" className="text-sm font-medium text-blue-600">
          Preview merchant stack
        </Link>
        <Link href="/(driver)" className="text-sm font-medium text-blue-600">
          Preview driver stack
        </Link>
      </View>
    </EmptyState>
  );
}
