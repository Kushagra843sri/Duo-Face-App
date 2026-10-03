import { useRef, useState } from 'react';
import { Store } from 'lucide-react-native';
import { Text, TextInput, View } from 'react-native';

import { Button, usePalette } from '@/components/ui';
import { authService } from '@/lib/authService';
import type { PhoneSignInConfirmation } from '@/lib/authService';

function describeSignInError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'Enter a valid phone number including country code, e.g. +919876543210.';
    case 'auth/invalid-verification-code':
    case 'auth/code-expired':
      return 'That code is incorrect or expired. Try again or request a new one.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a while and try again.';
    case 'auth/network-request-failed':
      return 'Unable to connect. Check your connection and try again.';
    default:
      return error instanceof Error && !code ? error.message : 'Sign-in failed. Please try again.';
  }
}

/**
 * Phone number -> OTP. Successful verification only establishes the
 * Firebase session; the parent's auth-state subscription then triggers
 * role resolution via /auth/me. This screen has no role concept at all.
 */
export function PhoneSignIn() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<PhoneSignInConfirmation | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const palette = usePalette();

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(describeSignInError(err));
    } finally {
      busyRef.current = false;
      setIsBusy(false);
    }
  }

  if (!authService.isConfigured) {
    return (
      <View className="flex-1 items-center justify-center gap-2 bg-canvas px-8 dark:bg-canvas-dark">
        <Text className="text-lg font-bold text-red-600">Sign-in is not configured</Text>
        <Text className="text-center text-sm text-muted dark:text-muted-dark">
          Firebase settings are missing from this build (see app/.env.example). To just browse the UI, set EXPO_PUBLIC_UI_PREVIEW=merchant (or driver) in app/.env.local and restart Expo with: npx expo start -c
        </Text>
      </View>
    );
  }

  if (!authService.isPhoneSignInSupported) {
    return (
      <View className="flex-1 items-center justify-center gap-2 bg-canvas px-8 dark:bg-canvas-dark">
        <Text className="text-lg font-bold text-ink dark:text-ink-dark">Phone sign-in unavailable</Text>
        <Text className="text-center text-sm text-muted dark:text-muted-dark">
          Phone OTP on iOS/Android needs a native development build, which is not set up yet. Use the web build for now.
        </Text>
      </View>
    );
  }

  const inputClass =
    'h-14 rounded-2xl border border-line bg-surface px-4 text-lg text-ink dark:border-line-dark dark:bg-surface-dark dark:text-ink-dark';

  return (
    <View className="flex-1 justify-center gap-5 bg-canvas px-6 dark:bg-canvas-dark">
      <View className="items-center gap-3">
        <View className="h-20 w-20 items-center justify-center rounded-3xl bg-emerald-600">
          <Store size={38} color="#ffffff" />
        </View>
        <Text className="text-3xl font-extrabold text-ink dark:text-ink-dark">Duo-Face</Text>
        <Text className="text-center text-sm text-muted dark:text-muted-dark">
          {confirmation === null ? 'Sign in or create an account with your phone number.' : 'Enter the 6-digit code we sent you.'}
        </Text>
      </View>

      {confirmation === null ? (
        <>
          <TextInput
            className={inputClass}
            placeholder="+919876543210"
            placeholderTextColor={palette.muted}
            keyboardType="phone-pad"
            autoComplete="tel"
            value={phone}
            onChangeText={setPhone}
            editable={!isBusy}
          />
          <Button
            label="Send code"
            loading={isBusy}
            disabled={phone.trim().length === 0}
            onPress={() =>
              run(async () => {
                setConfirmation(await authService.signInWithPhone(phone.trim()));
              })
            }
          />
        </>
      ) : (
        <>
          <TextInput
            className={`${inputClass} text-center tracking-widest`}
            placeholder="6-digit code"
            placeholderTextColor={palette.muted}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            value={code}
            onChangeText={setCode}
            editable={!isBusy}
          />
          <Button label="Verify" loading={isBusy} disabled={code.trim().length === 0} onPress={() => run(() => confirmation.confirmCode(code.trim()))} />
          <Button
            label="Use a different number"
            variant="ghost"
            onPress={() => {
              setConfirmation(null);
              setCode('');
              setError(null);
            }}
          />
        </>
      )}

      {error ? <Text className="text-center text-sm font-medium text-red-600">{error}</Text> : null}
    </View>
  );
}
