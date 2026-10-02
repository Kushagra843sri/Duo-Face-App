import '../global.css';
// Registers the on-duty background location task in the global scope (must run at bundle load, not in a component).
import '@/lib/dutyTask';

import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useIsDark } from '@/components/ui/theme';
import { useNavTheme } from '@/constants/navigation';
import { previewRole } from '@/lib/preview';

/** Dev-only. A slim pill under the status bar rather than a full-width block. */
function PreviewBanner({ role }: { role: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 2, pointerEvents: 'none' }} className="absolute inset-x-0 top-0 z-50 items-center">
      <View className="rounded-full bg-amber-400 px-3 py-0.5">
        <Text className="text-[10px] font-bold text-black">PREVIEW · {role} · sample data</Text>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const theme = useNavTheme();
  const dark = useIsDark();

  return (
    <ErrorBoundary>
      <ThemeProvider value={theme}>
        <StatusBar style={dark ? 'light' : 'dark'} />
        <View className="flex-1">
          <Stack screenOptions={{ headerShown: false }} />
          {previewRole ? <PreviewBanner role={previewRole} /> : null}
        </View>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
