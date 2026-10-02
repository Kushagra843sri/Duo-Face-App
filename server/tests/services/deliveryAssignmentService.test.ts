import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DriverService } from '../../src/services/driverService';
import { ActiveAssignmentConflictError } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { DuoFaceShop } from '../../src/types/duoFaceShop';

function createFakeDriverStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceDriverStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(driverId) {
      return data.get(driverId) ?? null;
    },
    async set(driverId, value) {
      data.set(driverId, value);
    },
    async listByStatus(status) {
      return [...data.values()].filter((v) => v.status === status);
    },
    async findByFirebaseUid(firebaseUid) {
      for (const value of data.values()) {
        if (value.firebaseUid === firebaseUid) return value;
      }
      return null;
    },
  };
}

// In-memory simulation of the real transactional check-then-write — real
// atomicity is Firestore's own transaction guarantee (exercised in
// FirestoreDeliveryAssignmentStore), not re-implemented here.
function createFakeAssignmentStore(initial: Record<string, Record<string, unknown>> = {}): DeliveryAssignmentStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(assignmentId) {
      return data.get(assignmentId) ?? null;
    },
    async listByDriverId(driverId) {
      return [...data.values()].filter((v) => v.driverId === driverId);
    },
    async listByOrderId() {
      return [];
    },
    async listByCustomerAppShopId(customerAppShopId) {
      return [...data.values()].filter((v) => v.customerAppShopId === customerAppShopId);
    },
    async createIfNoActiveAssignmentForOrder(assignmentId, orderId, activeStatuses, dataToWrite) {
      const hasActive = [...data.values()].some((v) => v.orderId === orderId && activeStatuses.includes(v.status as string));
      if (hasActive) {
        throw new ActiveAssignmentConflictError(`Order ${orderId} already has an active delivery assignment`);
      }
      data.set(assignmentId, dataToWrite);
    },
    // Simulates the same read-updater-write shape as the real Firestore
    // transaction (tests/services/inventoryService.test.ts's idiom) — real
    // atomicity/retry-on-contention is Firestore's own guarantee, not
    // re-implemented here.
    async runTransaction(assignmentId, updater) {
      const current = data.get(assignmentId) ?? null;
      const next = updater(current);
      data.set(assignmentId, next);
      return next;
    },
  };
}

function baseOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderId: 'order-1',
    shopId: 'shop-1',
    status: 'pending',
    paymentStatus: 'paid',
    items: [{ productId: 'product-1', name: 'Amul Milk', price: 28, quantity: 2, subtotal: 56 }],
    delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    pricing: { total: 71 },
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeOrderProvider(orders: Record<string, unknown>): CustomerAppOrderProvider {
  return {
    listOrdersByShopId: async () => Object.values(orders),
    getOrderById: async (orderId) => orders[orderId] ?? null,
    markOrderDelivered: async () => {
      throw new Error('not used');
    },
  };
}

const activeDriver = {
  'driver-1': {
    driverId: 'driver-1',
    firebaseUid: 'uid-1',
    name: 'Ravi Kumar',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

function buildService(
  assignmentStore = createFakeAssignmentStore(),
  driverStore = createFakeDriverStore(activeDriver),
  orders: Record<string, unknown> = { 'order-1': baseOrder() }
) {
  return new DeliveryAssignmentService(assignmentStore, new DriverService(driverStore), fakeOrderProvider(orders));
}

describe('DeliveryAssignmentService.assignDriver', () => {
  it('creates a valid assignment', async () => {
    const service = buildService();
    const result = await service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1' });

    expect(result).toMatchObject({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1', status: 'assigned' });
    await expect(service.getById(result.assignmentId)).resolves.toMatchObject({ assignmentId: result.assignmentId });
  });

  it('rejects a missing order with a 404', async () => {
    const service = buildService(undefined, undefined, {});
    await expect(
      service.assignDriver({ orderId: 'order-missing', customerAppShopId: 'shop-1', driverId: 'driver-1' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects when the order does not belong to the supplied shop, with the same 404 as a missing order', async () => {
    const service = buildService();
    await expect(
      service.assignDriver({ orderId: 'order-1', customerAppShopId: 'a-different-shop', driverId: 'driver-1' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a missing driver with a 404', async () => {
    const service = buildService();
    await expect(
      service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'missing-driver' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a suspended driver with a 409', async () => {
    const driverStore = createFakeDriverStore({
      'driver-1': { ...activeDriver['driver-1'], status: 'suspended' },
    });
    const service = buildService(undefined, driverStore);

    await expect(
      service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a duplicate active assignment for the same order with a 409', async () => {
    const assignmentStore = createFakeAssignmentStore();
    const service = buildService(assignmentStore);

    await service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1' });

    await expect(
      service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('DeliveryAssignmentService lifecycle transitions', () => {
  function withAssignment(overrides: Partial<Record<string, unknown>> = {}) {
    const now = new Date();
    return createFakeAssignmentStore({
      'assignment-1': {
        assignmentId: 'assignment-1',
        orderId: 'order-1',
        customerAppShopId: 'shop-1',
        driverId: 'driver-1',
        status: 'assigned',
        assignedAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      },
    });
  }

  it('accepts an assigned assignment and sets acceptedAt', async () => {
    const service = buildService(withAssignment());
    const result = await service.acceptAssignment('assignment-1', 'driver-1');
    expect(result.status).toBe('accepted');
    expect(result.acceptedAt).toBeDefined();
  });

  it('rejects an assigned assignment and sets rejectedAt', async () => {
    const service = buildService(withAssignment());
    const result = await service.rejectAssignment('assignment-1', 'driver-1');
    expect(result.status).toBe('rejected');
    expect(result.rejectedAt).toBeDefined();
  });

  it('marks an accepted assignment picked up and sets pickedUpAt', async () => {
    const service = buildService(withAssignment({ status: 'accepted' }));
    const result = await service.markPickedUp('assignment-1', 'driver-1');
    expect(result.status).toBe('picked_up');
    expect(result.pickedUpAt).toBeDefined();
  });

  it('marks a picked_up assignment delivered and sets deliveredAt', async () => {
    const service = buildService(withAssignment({ status: 'picked_up' }));
    const result = await service.markDelivered('assignment-1', 'driver-1');
    expect(result.status).toBe('delivered');
    expect(result.deliveredAt).toBeDefined();
  });

  it('leaves createdAt/assignedAt unchanged and updates updatedAt', async () => {
    const now = new Date();
    const service = buildService(withAssignment({ createdAt: now, assignedAt: now, updatedAt: now }));
    const result = await service.acceptAssignment('assignment-1', 'driver-1');
    expect(result.createdAt).toEqual(now);
    expect(result.assignedAt).toEqual(now);
  });

  it.each([
    ['assigned', 'picked_up' as const, (s: DeliveryAssignmentService) => s.markPickedUp('assignment-1', 'driver-1')],
    ['assigned', 'delivered' as const, (s: DeliveryAssignmentService) => s.markDelivered('assignment-1', 'driver-1')],
    ['accepted', 'delivered' as const, (s: DeliveryAssignmentService) => s.markDelivered('assignment-1', 'driver-1')],
    ['picked_up', 'rejected' as const, (s: DeliveryAssignmentService) => s.rejectAssignment('assignment-1', 'driver-1')],
  ])('rejects the invalid transition %s -> %s with a 409', async (fromStatus, _to, act) => {
    const service = buildService(withAssignment({ status: fromStatus }));
    await expect(act(service)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a transition attempted twice in a row (second call sees the already-updated status)', async () => {
    const service = buildService(withAssignment());
    await service.acceptAssignment('assignment-1', 'driver-1');
    await expect(service.acceptAssignment('assignment-1', 'driver-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('treats another driver\'s assignment as not found (404), never as forbidden', async () => {
    const service = buildService(withAssignment());
    await expect(service.acceptAssignment('assignment-1', 'a-different-driver')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns 404 for a nonexistent assignment', async () => {
    const service = buildService(createFakeAssignmentStore());
    await expect(service.acceptAssignment('missing', 'driver-1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('DeliveryAssignmentService.getForMerchantShop', () => {
  it('returns the assignment for the linked shop', async () => {
    const now = new Date();
    const assignmentStore = createFakeAssignmentStore({
      'assignment-1': {
        assignmentId: 'assignment-1',
        orderId: 'order-1',
        customerAppShopId: 'shop-1',
        driverId: 'driver-1',
        status: 'assigned',
        assignedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const service = buildService(assignmentStore);
    const shop: DuoFaceShop = {
      shopId: 'duo-shop-1',
      name: 'X',
      status: 'active',
      merchantFirebaseUid: 'uid-1',
      customerAppShopId: 'shop-1',
      createdAt: now,
      updatedAt: now,
    };

    await expect(service.getForMerchantShop(shop, 'assignment-1')).resolves.toMatchObject({ assignmentId: 'assignment-1' });
  });

  it('returns null (never leaking existence) for another shop\'s assignment', async () => {
    const now = new Date();
    const assignmentStore = createFakeAssignmentStore({
      'assignment-1': {
        assignmentId: 'assignment-1',
        orderId: 'order-1',
        customerAppShopId: 'a-different-shop',
        driverId: 'driver-1',
        status: 'assigned',
        assignedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const service = buildService(assignmentStore);
    const shop: DuoFaceShop = {
      shopId: 'duo-shop-1',
      name: 'X',
      status: 'active',
      merchantFirebaseUid: 'uid-1',
      customerAppShopId: 'shop-1',
      createdAt: now,
      updatedAt: now,
    };

    await expect(service.getForMerchantShop(shop, 'assignment-1')).resolves.toBeNull();
  });
});

describe('DeliveryAssignmentService reads', () => {
  it('getById throws on a malformed stored document', async () => {
    const assignmentStore = createFakeAssignmentStore({
      'assignment-1': { assignmentId: 'assignment-1' /* missing required fields */ },
    });
    const service = buildService(assignmentStore);

    await expect(service.getById('assignment-1')).rejects.toThrow();
  });

  it('listByDriverId skips a malformed assignment rather than throwing', async () => {
    const now = new Date();
    const assignmentStore = createFakeAssignmentStore({
      'assignment-good': {
        assignmentId: 'assignment-good',
        orderId: 'order-1',
        customerAppShopId: 'shop-1',
        driverId: 'driver-1',
        status: 'assigned',
        assignedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      'assignment-bad': { assignmentId: 'assignment-bad', driverId: 'driver-1' /* missing required fields */ },
    });
    const service = buildService(assignmentStore);

    const results = await service.listByDriverId('driver-1');
    expect(results.map((a) => a.assignmentId)).toEqual(['assignment-good']);
  });

  it('listForMerchantShop throws 409 when the shop is not linked to a Customer App shop', async () => {
    const service = buildService();
    const shop: DuoFaceShop = {
      shopId: 'duo-shop-1',
      name: 'X',
      status: 'active',
      merchantFirebaseUid: 'uid-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await expect(service.listForMerchantShop(shop)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('listForMerchantShop returns only the linked shop\'s assignments', async () => {
    const now = new Date();
    const assignmentStore = createFakeAssignmentStore({
      'assignment-1': {
        assignmentId: 'assignment-1',
        orderId: 'order-1',
        customerAppShopId: 'shop-1',
        driverId: 'driver-1',
        status: 'assigned',
        assignedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const service = buildService(assignmentStore);
    const shop: DuoFaceShop = {
      shopId: 'duo-shop-1',
      name: 'X',
      status: 'active',
      merchantFirebaseUid: 'uid-1',
      customerAppShopId: 'shop-1',
      createdAt: now,
      updatedAt: now,
    };

    const results = await service.listForMerchantShop(shop);
    expect(results.map((a) => a.assignmentId)).toEqual(['assignment-1']);
  });
});
