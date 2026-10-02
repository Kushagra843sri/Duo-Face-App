import { useRouter } from 'expo-router';
import { CloudOff, ShieldAlert, TriangleAlert } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { ApiError, NetworkError } from '@/api/client';
import { Button } from '@/components/ui';
import { authService } from '@/lib/authService';

export interface ErrorDescription {
  title: string;
  description?: string;
}

/**
 * Pure and exported so it's ready to test once the app has a test
 * framework — none exists yet (same state as Phase 1's decision), so no
 * new one is introduced just to test this one function.
 */
export function describeError(error: unknown, forbiddenMessage?: string): ErrorDescription {
  if (error instanceof NetworkError) {
    return { title: 'Unable to connect', description: 'Check your connection and try again.' };
  }

  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return { title: 'Invalid input', description: error.message };
      case 401:
        return { title: 'Session expired', description: 'Please sign in again.' };
      case 403:
        return { title: 'Not authorized', description: forbiddenMessage ?? 'Your account is not authorized for this.' };
      case 404:
        return { title: 'Not found', description: error.message };
      case 409:
        return {
          title: 'Setup required',
          description: error.message || 'This merchant shop is not linked to a Customer App shop yet.',
        };
      default:
        return { title: 'Something went wrong', description: error.message };
    }
  }

  return { title: 'Something went wrong', description: error instanceof Error ? error.message : undefined };
}

interface Props {
  error: unknown;
  retry: () => void;
  /** Overrides the default 403 message with something screen-specific. */
  forbiddenMessage?: string;
}

export function ErrorState({ error, retry, forbiddenMessage }: Props) {
  const { title, description } = describeError(error, forbiddenMessage);
  const router = useRouter();
  // 401/403 mean this session can't use this area (expired, or wrong/no role):
  // offer a way out instead of a dead end.
  const canSignOut = error instanceof ApiError && (error.status === 401 || error.status === 403);

  const Icon = error instanceof NetworkError ? CloudOff : canSignOut ? ShieldAlert : TriangleAlert;

  return (
    <View className="flex-1 items-center justify-center gap-3 bg-canvas px-8 dark:bg-canvas-dark">
      <View className="h-20 w-20 items-center justify-center rounded-full bg-red-100 dark:bg-red-950">
        <Icon size={36} color="#dc2626" />
      </View>
      <Text className="text-center text-lg font-bold text-ink dark:text-ink-dark">{title}</Text>
      {description ? <Text className="text-center text-sm text-muted dark:text-muted-dark">{description}</Text> : null}
      <View className="mt-2 w-full max-w-xs gap-2">
        <Button label="Try again" onPress={retry} />
        {canSignOut ? (
          <Button
            label="Sign out"
            variant="ghost"
            onPress={async () => {
              await authService.signOut();
              router.replace('/');
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
