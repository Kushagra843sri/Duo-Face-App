import { isValidTransition } from '../../src/services/deliveryAssignmentTransitions';

describe('isValidTransition', () => {
  it.each([
    ['assigned', 'accepted'],
    ['assigned', 'rejected'],
    ['assigned', 'cancelled'], // unanswered offer expires
    ['accepted', 'picked_up'],
    ['picked_up', 'delivered'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each([
    ['rejected', 'accepted'],
    ['rejected', 'assigned'],
    ['delivered', 'assigned'],
    ['delivered', 'accepted'],
    ['assigned', 'picked_up'],
    ['assigned', 'delivered'],
    ['accepted', 'delivered'],
    ['picked_up', 'rejected'],
    ['picked_up', 'assigned'],
    ['accepted', 'assigned'],
    ['cancelled', 'assigned'],
    ['accepted', 'cancelled'],
    ['picked_up', 'cancelled'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});
