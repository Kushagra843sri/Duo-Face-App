import { ApiError } from '@/api/errors';
import type { DeliveryOrder } from '@/api/deliveryOrder';
import type {
  DriverAssignment,
  DriverLocation,
  DriverLocationInput,
  DriverMe,
} from '@/api/driver';
import type {
  MerchantDeliveryAssignment,
  MerchantInventoryItem,
  MerchantMe,
  MerchantOrderDetail,
  MerchantProductCatalogEntry,
} from '@/api/merchant';
import { distanceMeters } from '@/lib/deliveryProximity';
import { adminPreviewRoute } from '@/lib/previewAdmin';
import { previewNotificationsRoute } from '@/lib/previewNotifications';
import { previewProfileRoute } from '@/lib/previewProfiles';
import { previewShopImageRoute } from '@/lib/previewShopImages';
import type { PreviewRole } from '@/lib/preview';

/**
 * Sample data + tiny in-memory handlers standing in for the Duo-Face API in
 * development UI preview (see lib/preview.ts). Deliberately fictional. State
 * lives only in memory and resets on reload; buttons work (accept, pick up,
 * assign, stock changes...) so flows can be exercised visually. Mirrors the
 * server's status rules loosely; it is NOT a test of the backend.
 */

type Status = DriverAssignment['status'];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SHOP_ID = 'preview-shop';
const DRIVER_ID = 'driver-1';

const products = [
  { productId: 'p-milk', name: 'Amul Milk 500 ml', price: 28 },
  { productId: 'p-bread', name: 'Whole Wheat Bread', price: 45 },
  { productId: 'p-eggs', name: 'Farm Eggs (12)', price: 84 },
  { productId: 'p-rice', name: 'Basmati Rice 1 kg', price: 130 },
];

const inventory = new Map<string, MerchantInventoryItem>([
  ['p-milk', { inventoryId: 'inv-milk', shopId: SHOP_ID, productId: 'p-milk', quantity: 24, reservedQuantity: 2, status: 'active' }],
  ['p-bread', { inventoryId: 'inv-bread', shopId: SHOP_ID, productId: 'p-bread', quantity: 3, reservedQuantity: 0, status: 'active' }],
]);

interface OrderSeed {
  orderId: string;
  createdMinutesAgo: number;
  items: Array<{ productId: string; name: string; quantity: number; price: number }>;
  address: string;
  phone: string;
  label: string;
  destination: { latitude: number; longitude: number };
}

const orders: OrderSeed[] = [
  { orderId: 'order-1001', createdMinutesAgo: 8, label: 'Home', address: '12/A, MG Road, Connaught Place, New Delhi 110001', phone: '+919800000001', destination: { latitude: 28.6315, longitude: 77.2167 }, items: [{ productId: 'p-milk', name: 'Amul Milk 500 ml', quantity: 2, price: 28 }, { productId: 'p-bread', name: 'Whole Wheat Bread', quantity: 1, price: 45 }] },
  { orderId: 'order-1002', createdMinutesAgo: 22, label: 'Office', address: '5th Floor, Tower B, Nehru Place, New Delhi 110019', phone: '+919800000002', destination: { latitude: 28.5494, longitude: 77.2509 }, items: [{ productId: 'p-eggs', name: 'Farm Eggs (12)', quantity: 1, price: 84 }] },
  { orderId: 'order-1003', createdMinutesAgo: 41, label: 'Home', address: '44, Green Park Extension, New Delhi 110016', phone: '+919800000003', destination: { latitude: 28.5583, longitude: 77.2028 }, items: [{ productId: 'p-rice', name: 'Basmati Rice 1 kg', quantity: 2, price: 130 }] },
  { orderId: 'order-1004', createdMinutesAgo: 190, label: 'Home', address: '9, Lajpat Nagar II, New Delhi 110024', phone: '+919800000004', destination: { latitude: 28.5677, longitude: 77.2432 }, items: [{ productId: 'p-milk', name: 'Amul Milk 500 ml', quantity: 3, price: 28 }] },
];

const drivers: Array<{ driverId: string; name: string; phoneNumber?: string; status: 'active' }> = [
  { driverId: 'driver-1', name: 'Ravi Kumar', phoneNumber: '+919811100001', status: 'active' },
  { driverId: 'driver-2', name: 'Meera Singh', phoneNumber: '+919811100002', status: 'active' },
];

interface AssignmentState {
  assignmentId: string;
  orderId: string;
  driverId: string;
  status: Status;
  assignedAt: string;
  acceptedAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  rejectedAt?: string;
}

const assignments: AssignmentState[] = [
  { assignmentId: 'a-1', orderId: 'order-1002', driverId: DRIVER_ID, status: 'assigned', assignedAt: ago(15) },
  { assignmentId: 'a-2', orderId: 'order-1003', driverId: DRIVER_ID, status: 'accepted', assignedAt: ago(35), acceptedAt: ago(30) },
  { assignmentId: 'a-3', orderId: 'order-1004', driverId: DRIVER_ID, status: 'delivered', assignedAt: ago(180), acceptedAt: ago(170), pickedUpAt: ago(150), deliveredAt: ago(120) },
];

let driverLocation: { input: DriverLocationInput; capturedAt: string } | null = null;
let driverDuty: { onDuty: boolean; dutyChangedAt: string | null } = { onDuty: false, dutyChangedAt: null };

const orderOf = (orderId: string) => orders.find((o) => o.orderId === orderId);
const totalOf = (o: OrderSeed) => o.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
const notFound = (what = 'Not found.') => new ApiError(404, what, 'not_found');
const conflict = (message: string) => new ApiError(409, message, 'AppError');
const assignmentOf = (id: string) => assignments.find((a) => a.assignmentId === id);
const driverName = (id: string) => drivers.find((d) => d.driverId === id)?.name ?? null;

function driverDto(a: AssignmentState): DriverAssignment {
  return {
    assignmentId: a.assignmentId,
    orderId: a.orderId,
    customerAppShopId: SHOP_ID,
    driverId: a.driverId,
    status: a.status,
    assignedAt: a.assignedAt,
    acceptedAt: a.acceptedAt,
    rejectedAt: a.rejectedAt,
    pickedUpAt: a.pickedUpAt,
    deliveredAt: a.deliveredAt,
    createdAt: a.assignedAt,
    updatedAt: a.deliveredAt ?? a.pickedUpAt ?? a.acceptedAt ?? a.assignedAt,
  };
}

function merchantDeliveryDto(a: AssignmentState): MerchantDeliveryAssignment {
  const d = drivers.find((x) => x.driverId === a.driverId);
  return {
    ...driverDto(a),
    driverName: d?.name ?? null,
    ...(d?.phoneNumber ? { driverPhoneNumber: d.phoneNumber } : {}),
  };
}

/** Same rule as the server (docs/decisions/028): a driver never gets the customer's phone. */
function deliveryOrderDto(a: AssignmentState, forDriver: boolean): DeliveryOrder {
  const o = orderOf(a.orderId);
  if (!o) throw notFound();
  const phoneVisible = !forDriver;
  return {
    assignmentId: a.assignmentId,
    orderId: o.orderId,
    shopName: 'Fresh Mart (preview)',
    delivery: { label: o.label, fullAddress: o.address, ...(phoneVisible ? { phoneNumber: o.phone } : {}) },
    ...(forDriver ? { destination: o.destination } : {}),
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
    itemCount: o.items.length,
    total: totalOf(o),
  };
}

/** Sample order statuses and shop state, changed by the shop's buttons. Same allowed moves as the server. */
const orderStatus = new Map<string, string>();
const NEXT: Record<string, string[]> = { pending: ['confirmed', 'rejected'], confirmed: ['preparing'], preparing: ['ready_for_pickup'] };
const shopState = { isOpen: false };
const hiddenProducts = new Set<string>();

function orderSummary(o: OrderSeed) {
  const current = assignments.filter((a) => a.orderId === o.orderId).at(-1);
  return {
    orderId: o.orderId,
    status: orderStatus.get(o.orderId) ?? 'pending',
    itemCount: o.items.length,
    total: totalOf(o),
    createdAt: ago(o.createdMinutesAgo),
    deliveryAssignment: current ? { assignmentId: current.assignmentId, status: current.status } : null,
  };
}

function orderDetail(o: OrderSeed): MerchantOrderDetail {
  return {
    ...orderSummary(o),
    items: o.items.map((i) => ({ ...i, subtotal: i.price * i.quantity })),
    delivery: { label: o.label, fullAddress: o.address, phoneNumber: o.phone },
    paymentStatus: 'paid',
  };
}

function catalog(): MerchantProductCatalogEntry[] {
  return products.map((p) => {
    const inv = inventory.get(p.productId);
    return {
      ...p,
      description: null,
      isActive: !hiddenProducts.has(p.productId),
      inStock: inv ? inv.status === 'active' && inv.quantity > 0 : true,
      inventory: inv ? { quantity: inv.quantity, reservedQuantity: inv.reservedQuantity, status: inv.status } : null,
    };
  });
}

function transition(a: AssignmentState, to: Status, allowedFrom: Status[]): DriverAssignment {
  if (a.driverId !== DRIVER_ID) throw notFound('Assignment not found.');
  if (!allowedFrom.includes(a.status)) throw conflict(`Cannot transition assignment from ${a.status} to ${to}.`);
  a.status = to;
  const now = new Date().toISOString();
  if (to === 'accepted') a.acceptedAt = now;
  if (to === 'rejected') a.rejectedAt = now;
  if (to === 'picked_up') a.pickedUpAt = now;
  if (to === 'delivered') a.deliveredAt = now;
  return driverDto(a);
}

function ensureItem(productId: string): MerchantInventoryItem {
  const item = inventory.get(productId);
  if (!item) throw notFound('Inventory item not found.');
  return item;
}

/** Routes one preview request. `body` is the parsed JSON body (if any). */
function route(role: PreviewRole, method: string, path: string, body: Record<string, unknown>): unknown {
  const [pathname] = path.split('?');
  const seg = pathname.split('/').filter(Boolean);
  const is = (...expected: string[]) => expected.length === seg.length && expected.every((e, i) => e === '*' || e === seg[i]);

  if (is('auth', 'me')) {
    return { firebaseUid: 'preview-user', role, ...(role === 'merchant' ? { shopId: SHOP_ID } : role === 'driver' ? { driverId: DRIVER_ID } : {}) };
  }

  const notifications = previewNotificationsRoute(role, method, pathname);
  if (notifications !== undefined) return notifications;

  if (role === 'admin') return adminPreviewRoute(method, seg, body);

  if (role === 'merchant') {
    if (is('merchant', 'me')) return { firebaseUid: 'preview-user', role: 'merchant', shopId: SHOP_ID, shopName: 'Fresh Mart (preview)' } satisfies MerchantMe;
    if (is('merchant', 'shop')) return { shopId: SHOP_ID, name: 'Fresh Mart (preview)', listed: true, isOpen: shopState.isOpen };
    if (is('merchant', 'shop', 'open')) {
      shopState.isOpen = body.isOpen === true;
      return { shopId: SHOP_ID, name: 'Fresh Mart (preview)', listed: true, isOpen: shopState.isOpen };
    }
    if (is('merchant', 'products') && method === 'POST') {
      const productId = `p-new-${products.length + 1}`;
      const pricePaise = Number(body.pricePaise);
      if (!Number.isInteger(pricePaise) || pricePaise < 100) throw new ApiError(400, 'The minimum price is Rs 1.');
      products.push({ productId, name: String(body.name), price: pricePaise / 100 });
      inventory.set(productId, { inventoryId: `inv-${productId}`, shopId: SHOP_ID, productId, quantity: Number(body.quantity ?? 0), reservedQuantity: 0, status: 'active' });
      return catalog().find((p) => p.productId === productId);
    }
    if (is('merchant', 'products', '*') && method === 'PATCH') {
      const product = products.find((p) => p.productId === seg[2]);
      if (!product) throw notFound('Product not found.');
      if (typeof body.name === 'string') product.name = body.name;
      if (typeof body.pricePaise === 'number') product.price = body.pricePaise / 100;
      if (typeof body.isAvailable === 'boolean') {
        if (body.isAvailable) hiddenProducts.delete(product.productId);
        else hiddenProducts.add(product.productId);
      }
      return catalog().find((p) => p.productId === product.productId);
    }
    if (is('merchant', 'products')) return catalog();
    if (is('merchant', 'inventory') && method === 'GET') return [...inventory.values()];
    if (is('merchant', 'inventory') && method === 'POST') {
      const productId = String(body.productId);
      if (inventory.has(productId)) throw conflict('Inventory already exists for this product.');
      const item: MerchantInventoryItem = { inventoryId: `inv-${productId}`, shopId: SHOP_ID, productId, quantity: Number(body.quantity ?? 0), reservedQuantity: 0, status: 'active' };
      inventory.set(productId, item);
      return item;
    }
    if (is('merchant', 'inventory', '*') && method === 'GET') return ensureItem(seg[2]);
    if (is('merchant', 'inventory', '*', 'quantity')) return Object.assign(ensureItem(seg[2]), { quantity: Number(body.quantity) });
    if (is('merchant', 'inventory', '*', 'adjust')) {
      const item = ensureItem(seg[2]);
      const next = item.quantity + Number(body.delta);
      if (next < 0) throw conflict('Quantity cannot go below zero.');
      item.quantity = next;
      return item;
    }
    if (is('merchant', 'inventory', '*', 'disable')) return Object.assign(ensureItem(seg[2]), { status: 'disabled' as const });
    if (is('merchant', 'orders', '*', 'status') && method === 'PATCH') {
      const id = seg[2];
      if (!orderOf(id)) throw notFound('Order not found.');
      const from = orderStatus.get(id) ?? 'pending';
      if (!(NEXT[from] ?? []).includes(String(body.status))) throw conflict(`Order cannot move from ${from} to ${String(body.status)}`);
      orderStatus.set(id, String(body.status));
      return { orderId: id, status: String(body.status) };
    }
    if (is('merchant', 'orders')) return orders.map(orderSummary);
    if (is('merchant', 'orders', '*')) {
      const o = orderOf(seg[2]);
      if (!o) throw notFound('Order not found.');
      return orderDetail(o);
    }
    if (is('merchant', 'deliveries') && method === 'GET') return [...assignments].reverse().map(merchantDeliveryDto);
    if (is('merchant', 'deliveries') && method === 'POST') {
      const orderId = String(body.orderId);
      if (!orderOf(orderId)) throw notFound('Order not found.');
      if (assignments.some((a) => a.orderId === orderId && ['assigned', 'accepted', 'picked_up'].includes(a.status))) {
        throw conflict(`Order ${orderId} already has an active delivery assignment.`);
      }
      // Stand-in for the server's nearest-driver dispatch: first driver with no active delivery.
      const free = drivers.find((d) => !assignments.some((a) => a.driverId === d.driverId && ['assigned', 'accepted', 'picked_up'].includes(a.status)));
      if (!free) throw conflict('No driver available nearby right now.');
      const created: AssignmentState = { assignmentId: `a-${assignments.length + 1}`, orderId, driverId: free.driverId, status: 'assigned', assignedAt: new Date().toISOString() };
      assignments.push(created);
      return merchantDeliveryDto(created);
    }
    if (is('merchant', 'deliveries', '*', 'order')) {
      const a = assignmentOf(seg[2]);
      if (!a) throw notFound('Assignment not found.');
      return deliveryOrderDto(a, false);
    }
    if (is('merchant', 'deliveries', '*')) {
      const a = assignmentOf(seg[2]);
      if (!a) throw notFound('Assignment not found.');
      return merchantDeliveryDto(a);
    }
  }

  const profile = previewProfileRoute(role, method, pathname, body);
  if (profile !== undefined) return profile;
  const shopImages = previewShopImageRoute(method, pathname);
  if (shopImages !== undefined) return shopImages;

  if (role === 'driver') {
    if (is('driver', 'me')) return { firebaseUid: 'preview-user', role: 'driver', driverId: DRIVER_ID, name: 'Ravi Kumar', phoneNumber: '+919811100001', status: 'active' } satisfies DriverMe;
    const mine = () => assignments.filter((a) => a.driverId === DRIVER_ID);
    if (is('driver', 'assignments')) return [...mine()].reverse().map(driverDto);
    if (is('driver', 'assignments', '*')) {
      const a = assignmentOf(seg[2]);
      if (!a || a.driverId !== DRIVER_ID) throw notFound('Assignment not found.');
      return driverDto(a);
    }
    if (is('driver', 'assignments', '*', 'order')) {
      const a = assignmentOf(seg[2]);
      if (!a || a.driverId !== DRIVER_ID || a.status === 'rejected') throw notFound('Assignment not found.');
      return deliveryOrderDto(a, true);
    }
    if (is('driver', 'assignments', '*', 'accept')) return transition(assignmentOf(seg[2]) ?? notFoundThrow(), 'accepted', ['assigned']);
    if (is('driver', 'assignments', '*', 'reject')) return transition(assignmentOf(seg[2]) ?? notFoundThrow(), 'rejected', ['assigned']);
    if (is('driver', 'assignments', '*', 'pickup')) return transition(assignmentOf(seg[2]) ?? notFoundThrow(), 'picked_up', ['accepted']);
    if (is('driver', 'assignments', '*', 'deliver')) {
      const a = assignmentOf(seg[2]) ?? notFoundThrow();
      // Same two proofs as the server: the customer code (preview: 123456) or a fix within 50 m.
      const otp = typeof body.otp === 'string' ? body.otp : null;
      const fix = body.location as { latitude: number; longitude: number; accuracyMeters?: number } | undefined;
      if (otp !== null) {
        if (otp !== '123456') throw conflict('Incorrect code. 4 attempts left.');
      } else if (fix) {
        const dest = orderOf(a.orderId)?.destination;
        if (!dest) throw conflict('The delivery location is unavailable. Ask the customer for their delivery code.');
        const meters = distanceMeters(dest, fix);
        if (meters > 50) throw conflict(`You are about ${Math.max(10, Math.round(meters / 10) * 10)} m from the delivery location. Get within 50 m to mark it delivered.`);
      } else {
        throw new ApiError(400, 'Send exactly one of location or otp.', 'invalid_request');
      }
      return transition(a, 'delivered', ['picked_up']);
    }

    if (is('driver', 'duty') && method === 'GET') return driverDuty;
    if (is('driver', 'duty') && method === 'PUT') {
      const onDuty = body.onDuty === true;
      // Same rule as the server: no going off duty with a delivery in progress.
      if (!onDuty && mine().some((a) => ['assigned', 'accepted', 'picked_up'].includes(a.status))) {
        throw conflict('Finish or reject your current delivery first.');
      }
      driverDuty = { onDuty, dutyChangedAt: new Date().toISOString() };
      return driverDuty;
    }
    if (is('driver', 'location') && method === 'GET') return locationDto();
    if (is('driver', 'location') && method === 'POST') {
      driverLocation = { input: body as unknown as DriverLocationInput, capturedAt: new Date().toISOString() };
      return locationDto();
    }
    if (is('driver', 'tracking', 'location') && method === 'POST') {
      const a = assignmentOf(String(body.assignmentId));
      if (!a || a.driverId !== DRIVER_ID) throw notFound('Assignment not found.');
      if (!['accepted', 'picked_up'].includes(a.status)) throw conflict('This assignment is not eligible for live tracking.');
      // The real service snapshots the first live ping (then once a minute) into the stored last location.
      const { assignmentId: _ignored, ...fix } = body as Record<string, unknown>;
      void _ignored;
      driverLocation = { input: fix as unknown as DriverLocationInput, capturedAt: new Date().toISOString() };
      return { capturedAt: new Date().toISOString() };
    }
    if (is('driver', 'tracking', 'location') && method === 'DELETE') return null;
  }

  throw notFound(`No preview data for ${method} ${pathname}.`);
}

function notFoundThrow(): never {
  throw notFound('Assignment not found.');
}

function locationDto(): DriverLocation {
  if (!driverLocation) throw notFound('No location recorded yet.');
  return { ...driverLocation.input, capturedAt: driverLocation.capturedAt, updatedAt: driverLocation.capturedAt, freshness: 'fresh' };
}

/** Entry point used by api/client.ts in preview mode. Simulates a little latency so loading states are visible. */
export async function previewRequest<T>(role: PreviewRole, path: string, init: RequestInit): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const method = (init.method ?? 'GET').toUpperCase();
  let body: Record<string, unknown> = {};
  if (typeof init.body === 'string' && init.body.length > 0) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return route(role, method, path, body) as T;
}
