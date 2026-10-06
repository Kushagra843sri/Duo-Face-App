import { Redirect } from 'expo-router';
import { UserX } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PhoneSignIn } from '@/components/PhoneSignIn';
import { RegisterChoice } from '@/components/RegisterChoice';
import { Button, IconChip } from '@/components/ui';
import { useAuthUser } from '@/hooks/useAuthUser';
import { useRole } from '@/hooks/useRole';
import { authService } from '@/lib/authService';

/**
 * Root routing: no Firebase user -> sign-in; Firebase user -> GET /auth/me,
 * and the backend-resolved role picks the stack. A Firebase login alone
 * never grants a role: an unmapped identity (403) is offered account
 * creation, which the server records (POST /auth/register).
 */
export default function Index() {
  const { user, isInitializing } = useAuthUser();
  const { role, isLoading, error, denied, retry } = useRole(user?.uid ?? null);

  if (isInitializing) {
    return <LoadingState label="Checking your session…" />;
  }

  if (!user) {
    return <PhoneSignIn />;
  }

  if (isLoading) {
    return <LoadingState label="Resolving your role…" />;
  }

  if (error) {
    return <ErrorState error={error} retry={retry} />;
  }

  if (role === 'merchant') {
    return <Redirect href="/(merchant)" />;
  }

  if (role === 'driver') {
    return <Redirect href="/(driver)" />;
  }

  if (role === 'admin') {
    return <Redirect href="/(admin)" />;
  }

  // Signed in, but the server has no role for this account: offer to create one.
  if (denied?.status === 403) {
    return <RegisterChoice onRegistered={retry} />;
  }

  const sessionRejected = denied?.status === 401;
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-canvas px-8 dark:bg-canvas-dark">
      <IconChip icon={UserX} size={72} />
      <Text className="text-center text-lg font-bold text-ink dark:text-ink-dark">
        {sessionRejected ? 'Session expired' : 'Something went wrong'}
      </Text>
      <Text className="text-center text-sm text-muted dark:text-muted-dark">
        {sessionRejected
          ? 'Please sign in again.'
          : 'We could not load your account. Please try again.'}
      </Text>
      <View className="mt-2 w-full max-w-xs gap-2">
        <Button label="Try again" onPress={retry} />
        <Button label="Sign out" variant="ghost" onPress={() => authService.signOut()} />
      </View>
    </View>
  );
}
