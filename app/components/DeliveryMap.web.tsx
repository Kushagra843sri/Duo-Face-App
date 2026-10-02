import { Text } from 'react-native';

import type { Coordinate } from '@/lib/deliveryMap';

interface Props {
  destination: Coordinate;
  driverLocation?: Coordinate | null;
}

// react-native-maps has no web implementation; use "Open in Maps" on web.
export function DeliveryMap(_props: Props) {
  return <Text className="text-sm text-muted dark:text-muted-dark">The in-app map is available on iOS and Android. Use Open in Maps.</Text>;
}
