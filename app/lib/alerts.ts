import { Alert, Platform } from 'react-native';

/**
 * react-native-web's Alert.alert is a no-op, so on web a confirmation would
 * silently never fire (and the action could never run). Native keeps the
 * real Alert; web falls back to window.confirm/alert.
 */
export function showAlert(title: string, message?: string) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

export function confirmAlert(options: { title: string; message: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void }) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${options.title}\n\n${options.message}`)) options.onConfirm();
    return;
  }
  Alert.alert(options.title, options.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: options.confirmLabel, style: options.destructive ? 'destructive' : 'default', onPress: options.onConfirm },
  ]);
}
