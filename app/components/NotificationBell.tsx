import { useFocusEffect, useRouter } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';

import { usePalette } from '@/components/ui';
import { useUnreadCount } from '@/hooks/useUnreadCount';

/** Header bell with the unread count. Opens the inbox. */
export function NotificationBell() {
  const router = useRouter();
  const palette = usePalette();
  const { unread, refresh } = useUnreadCount();
  // Coming back from the inbox (where items were marked read) updates the number straight away.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      hitSlop={10}
      onPress={() => router.push('/notifications')}
      style={{ paddingHorizontal: 14 }}
    >
      <View>
        <Bell size={22} color={palette.text} />
        {unread > 0 ? (
          <View className="absolute -right-2 -top-1.5 min-w-[18px] items-center rounded-full bg-red-600 px-1">
            <Text className="text-[10px] font-extrabold text-white">{unread > 9 ? '9+' : unread}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
