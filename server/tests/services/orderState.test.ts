import { ALLOWED_TRANSITIONS, assertTransition, canTransition, InvalidOrderTransitionError, isTerminal } from '../../src/services/orderState';
import { orderFulfillmentStatusSchema } from '../../src/types/customerAppOrder';

const ALL = orderFulfillmentStatusSchema.options;

describe('orderState', () => {
  it('has an entry for every status', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('allows the happy path in order', () => {
    const path = ['pending', 'confirmed', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'delivered'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('never allows skipping a step or going backwards', () => {
    expect(canTransition('pending', 'preparing')).toBe(false);
    expect(canTransition('pending', 'delivered')).toBe(false);
    expect(canTransition('preparing', 'confirmed')).toBe(false);
    expect(canTransition('delivered', 'out_for_delivery')).toBe(false);
  });

  it('terminal statuses allow nothing', () => {
    for (const s of ['delivered', 'cancelled', 'rejected'] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const to of ALL) expect(canTransition(s, to)).toBe(false);
    }
  });

  it('only pending can be rejected; nothing can be cancelled once out for delivery', () => {
    expect(canTransition('pending', 'rejected')).toBe(true);
    expect(canTransition('confirmed', 'rejected')).toBe(false);
    expect(canTransition('out_for_delivery', 'cancelled')).toBe(false);
  });

  it('assertTransition throws a typed error for an invalid move', () => {
    expect(() => assertTransition('delivered', 'pending')).toThrow(InvalidOrderTransitionError);
    expect(() => assertTransition('pending', 'confirmed')).not.toThrow();
  });
});
