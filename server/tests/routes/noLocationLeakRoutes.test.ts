import request from 'supertest';

import { app } from '../../src/app';

describe('no unauthorized location/order lookup routes exist', () => {
  it.each([
    ['GET', '/driver/location/driver-1'],
    ['POST', '/driver/location/driver-1'],
    ['GET', '/driver/orders/order-1'],
    ['GET', '/merchant/drivers/driver-1/location'],
    ['GET', '/merchant/location'],
    ['GET', '/merchant/tracking/location/assignment-1'],
    ['GET', '/customer/tracking/location/assignment-1'],
    ['GET', '/merchant/drivers/driver-1/tracking'],
    ['POST', '/driver/tracking/location/driver-1'],
    ['DELETE', '/driver/tracking/location/driver-1'],
    ['POST', '/geocode'],
    ['GET', '/geocode'],
    ['POST', '/driver/geocode'],
    ['GET', '/driver/destinations/abc'],
    ['GET', '/merchant/deliveries/assignment-1/location'],
  ])('%s %s is not routed (404, not 401/403)', async (method, path) => {
    const response = await request(app)[method.toLowerCase() as 'get' | 'post' | 'delete'](path);
    expect(response.status).toBe(404);
  });
});
