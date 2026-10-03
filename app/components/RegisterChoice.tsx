import { useState } from 'react';
import { Bike, Store } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { ApiError, NetworkError } from '@/api/client';
import { registerAccount } from '@/api/register';
import { Field } from '@/components/profile/Field';
import { Button, Card, IconChip } from '@/components/ui';
import { authService } from '@/lib/authService';
import type { Role } from '@/types/auth';

const OPTIONS: { role: Role; title: string; subtitle: string; icon: typeof Store }[] = [
  { role: 'merchant', title: 'I run a shop', subtitle: 'Manage products, stock and orders, and request delivery partners.', icon: Store },
  { role: 'driver', title: 'I deliver orders', subtitle: 'Go on duty, accept nearby deliveries and earn per trip.', icon: Bike },
];

function describeError(error: unknown): string {
  if (error instanceof NetworkError) return 'Unable to connect. Check your connection and try again.';
  // Includes 409: the account already exists (e.g. suspended) — the server's message explains it.
  if (error instanceof ApiError) return error.message;
  return 'Could not create your account. Please try again.';
}

/**
 * Shown after phone sign-in when the server has no role for this account.
 * The choice is only a registration intent sent to POST /auth/register;
 * the server stores the role and `onRegistered` re-resolves it via /auth/me.
 */
export function RegisterChoice({ onRegistered }: { onRegistered: () => void }) {
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState('');
  const [shopName, setShopName] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = (role === 'merchant' ? shopName : name).trim();

  async function submit() {
    if (!role || isBusy || value.length === 0) return;
    setIsBusy(true);
    setError(null);
    try {
      await registerAccount(role === 'merchant' ? { intent: 'merchant', shopName: value } : { intent: 'driver', name: value });
      onRegistered();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-canvas dark:bg-canvas-dark" contentContainerClassName="flex-grow justify-center gap-4 p-6" keyboardShouldPersistTaps="handled">
      <View className="gap-1">
        <Text className="text-2xl font-extrabold text-ink dark:text-ink-dark">Create your account</Text>
        <Text className="text-sm text-muted dark:text-muted-dark">You are signed in. Tell us how you will use Duo-Face.</Text>
      </View>

      {OPTIONS.map(({ role: optionRole, title, subtitle, icon }) => {
        const selected = role === optionRole;
        return (
          <Pressable
            key={optionRole}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            disabled={isBusy}
            onPress={() => {
              setRole(optionRole);
              setError(null);
            }}
          >
            <Card className={`flex-row items-center gap-3 ${selected ? 'border-2 border-emerald-600' : ''}`}>
              <IconChip icon={icon} size={48} />
              <View className="flex-1 gap-0.5">
                <Text className="text-base font-bold text-ink dark:text-ink-dark">{title}</Text>
                <Text className="text-sm text-muted dark:text-muted-dark">{subtitle}</Text>
              </View>
            </Card>
          </Pressable>
        );
      })}

      {role ? (
        <View className="gap-3">
          <Field
            label={role === 'merchant' ? 'Shop name' : 'Your name'}
            value={role === 'merchant' ? shopName : name}
            onChangeText={role === 'merchant' ? setShopName : setName}
            maxLength={100}
            placeholder={role === 'merchant' ? 'e.g. Sharma Kirana' : 'e.g. Ravi Kumar'}
          />
          <Text className="text-xs text-muted dark:text-muted-dark">
            You can complete your profile and verification after this. An account type cannot be changed later.
          </Text>
          <Button label="Create account" loading={isBusy} disabled={value.length === 0} onPress={submit} />
        </View>
      ) : null}

      {error ? <Text className="text-center text-sm font-medium text-red-600">{error}</Text> : null}
      <Button label="Sign out" variant="ghost" onPress={() => authService.signOut()} />
    </ScrollView>
  );
}
