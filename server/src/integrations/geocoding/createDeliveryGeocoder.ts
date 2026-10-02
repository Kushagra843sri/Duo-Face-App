import { loadGeocodingConfig } from '../../config/geocoding';
import { FirestoreDeliveryDestinationStore } from '../firebase/FirestoreDeliveryDestinationStore';
import { CachedDeliveryGeocoder } from './CachedDeliveryGeocoder';
import { UnconfiguredDeliveryGeocoder } from './DeliveryGeocoder';
import type { DeliveryGeocoder } from './DeliveryGeocoder';
import { OpenCageGeocodingProvider } from './OpenCageGeocodingProvider';

/**
 * Composition root for geocoding. Without OPENCAGE_API_KEY the app runs
 * exactly as before: destinations are simply unavailable.
 */
export function createDeliveryGeocoder(source: NodeJS.ProcessEnv = process.env): DeliveryGeocoder {
  const config = loadGeocodingConfig(source);
  if (!config) return new UnconfiguredDeliveryGeocoder();

  return new CachedDeliveryGeocoder(new FirestoreDeliveryDestinationStore(), new OpenCageGeocodingProvider(config));
}
