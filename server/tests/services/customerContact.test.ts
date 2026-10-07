import { CONTACT_RADIUS_METERS, CustomerContactService } from '../../src/services/customerContactService';
import type { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import type { DeliveryOrderService } from '../../src/services/deliveryOrderService';
import type { DuoFaceDriver } from '../../src/types/duoFaceDriver';

const driver = { driverId: 'driver-1' } as DuoFaceDriver;
const destination = { latitude: 28.6315, longitude: 77.2167 };
/** `meters` north of the destination (1 degree of latitude is about 111,195 m). */
const fixAt = (meters: number, accuracyMeters: number | null = 10) => ({
  latitude: destination.latitude + meters / 111_195,
  longitude: destination.longitude,
  ...(accuracyMeters === null ? {} : { accuracyMeters }),
});

function build(opts: { status?: string; owner?: string; withDestination?: boolean; phone?: string | undefined } = {}) {
  const getForDriverWithPhone = jest.fn(async () => ({
    delivery: { label: 'Home', fullAddress: 'x', ...(opts.phone === undefined && 'phone' in opts ? {} : { phoneNumber: opts.phone ?? '+919800000001' }) },
    ...(opts.withDestination === false ? {} : { destination }),
  }));
  const assignments = {
    getById: async () => ({ assignmentId: 'a-1', driverId: opts.owner ?? 'driver-1', status: opts.status ?? 'picked_up' }),
  } as unknown as DeliveryAssignmentService;
  const orders = { getForDriverWithPhone } as unknown as DeliveryOrderService;
  return { service: new CustomerContactService(assignments, orders), getForDriverWithPhone };
}

describe('CustomerContactService', () => {
  it('releases the number to the delivering driver within the radius', async () => {
    const { service } = build();
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(120))).resolves.toEqual({ phoneNumber: '+919800000001' });
  });

  it('refuses beyond the radius, saying only a rounded distance', async () => {
    const { service } = build();
    const err = await service.getPhoneNumber(driver, 'a-1', fixAt(CONTACT_RADIUS_METERS + 200)).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409 });
    expect(err.message).toMatch(/about 500 m/);
    expect(err.message).not.toContain('+9198');
  });

  it('refuses a missing or imprecise GPS fix', async () => {
    const { service } = build();
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(10, 250))).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(10, null))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("answers 404 for another driver's assignment, without reading the order", async () => {
    const { service, getForDriverWithPhone } = build({ owner: 'driver-2' });
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(10))).rejects.toMatchObject({ statusCode: 404 });
    expect(getForDriverWithPhone).not.toHaveBeenCalled();
  });

  it.each(['assigned', 'accepted', 'delivered', 'rejected'])('refuses while the assignment is %s', async (status) => {
    const { service } = build({ status });
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(10))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses when the delivery location is unknown', async () => {
    const { service } = build({ withDestination: false });
    await expect(service.getPhoneNumber(driver, 'a-1', fixAt(10))).rejects.toMatchObject({ statusCode: 409 });
  });
});
