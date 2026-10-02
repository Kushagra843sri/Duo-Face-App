export interface GeocodedDestination {
  latitude: number;
  longitude: number;
}

/**
 * Boundary for turning a delivery address into coordinates. The Customer
 * App stores only a textual address (no lat/lng — see
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md), so coordinates must come
 * from a geocoding provider. Sending customer addresses to a third party is
 * a documented decision (docs/decisions/021): OpenCage, server-side only,
 * cached in duo_face_delivery_destinations. With no API key configured
 * the implementation is UnconfiguredDeliveryGeocoder, and callers must
 * treat null as "no map location" — never guess or invent coordinates.
 *
 * Implementations must return null (not throw) when an address can't be
 * resolved, must not persist results into Customer App data, and must not
 * log the address.
 */
export interface DeliveryGeocoder {
  geocode(fullAddress: string): Promise<GeocodedDestination | null>;
}

export class UnconfiguredDeliveryGeocoder implements DeliveryGeocoder {
  async geocode(): Promise<GeocodedDestination | null> {
    return null;
  }
}
