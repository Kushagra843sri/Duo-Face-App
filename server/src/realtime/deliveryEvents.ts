/**
 * Customer-safe delivery events (docs/decisions/023). Deliberately
 * minimal: no driverId, Firebase UID, assignmentId, address, phone,
 * accuracy/heading/speed or Redis data ever appears in an event.
 */
export type CustomerDeliveryStatus = 'pending' | 'assigned' | 'accepted' | 'picked_up' | 'delivered' | 'cancelled';

export type DeliveryTrackingEvent =
  | { type: 'driver_location'; location: { latitude: number; longitude: number; capturedAt: string } }
  | { type: 'delivery_status'; status: CustomerDeliveryStatus };

/** Where services announce events. Fire-and-forget: publishing must never fail the caller. */
export interface DeliveryEventPublisher {
  publish(orderId: string, event: DeliveryTrackingEvent): void;
}

/**
 * In-process fan-out point between the services that produce events and
 * the realtime gateway that delivers them. This is only the hand-off inside
 * one server process; cross-instance delivery is the Socket.IO Redis
 * adapter's job (see the gateway). Kept separate from the live-location
 * STATE store on purpose: state (Redis GEO) vs event transport.
 */
export class DeliveryEventHub implements DeliveryEventPublisher {
  private readonly sinks = new Set<(orderId: string, event: DeliveryTrackingEvent) => void>();

  addSink(sink: (orderId: string, event: DeliveryTrackingEvent) => void): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  publish(orderId: string, event: DeliveryTrackingEvent): void {
    for (const sink of this.sinks) {
      try {
        sink(orderId, event);
      } catch {
        console.warn('DeliveryEventHub: a sink failed'); // never break the publisher
      }
    }
  }
}

/** Process-wide hub used by default wiring. With no gateway attached, publishing is a no-op. */
export const deliveryEventHub = new DeliveryEventHub();
