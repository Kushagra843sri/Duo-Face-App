import type { CheckoutTx, CustomerStore } from '../../src/integrations/firebase/FirestoreCustomerStore';
import type { InventoryStore } from '../../src/integrations/firebase/FirestoreInventoryStore';

type Doc = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-memory CustomerStore. Transactions run one at a time (like Firestore
 * serialising contended transactions) and buffered writes are applied only if
 * the callback finishes, so an aborted checkout leaves no trace.
 * NOT a test of real Firestore semantics.
 */
export class FakeCustomerStore implements CustomerStore {
  docs = new Map<string, Doc>(); // key: `${collection}/${id}`
  private chain: Promise<unknown> = Promise.resolve();

  put(collection: string, id: string, data: Doc) {
    this.docs.set(`${collection}/${id}`, clone(data));
  }
  read(collection: string, id: string): Doc | undefined {
    const d = this.docs.get(`${collection}/${id}`);
    return d ? clone(d) : undefined;
  }
  private all(prefix: string): [string, Doc][] {
    return [...this.docs.entries()].filter(([k]) => k.startsWith(`${prefix}/`)).map(([k, v]) => [k.slice(prefix.length + 1), clone(v)]);
  }

  async listShops() {
    return this.all('shops').map(([id, d]) => ({ ...d, id }));
  }
  async getShop(id: string) {
    const d = this.read('shops', id);
    return d ? { ...d, id } : null;
  }
  async listProductsByShop(shopId: string) {
    return this.all('products').filter(([, d]) => d.shopId === shopId).map(([id, d]) => ({ ...d, id }));
  }
  async listAddresses(uid: string) {
    return this.all(`users/${uid}/addresses`).map(([id, d]) => ({ ...d, addressId: id }));
  }
  async getAddress(uid: string, id: string) {
    const d = this.read(`users/${uid}/addresses`, id);
    return d ? { ...d, addressId: id } : null;
  }
  async setAddress(uid: string, id: string, data: Doc) {
    this.put(`users/${uid}/addresses`, id, { ...(this.read(`users/${uid}/addresses`, id) ?? {}), ...data });
  }
  async deleteAddress(uid: string, id: string) {
    this.docs.delete(`users/${uid}/addresses/${id}`);
  }
  async listOrdersByCustomer(uid: string) {
    return this.all('orders').filter(([, d]) => d.customerId === uid).map(([id, d]) => ({ ...d, orderId: id }));
  }
  async getOrder(id: string) {
    const d = this.read('orders', id);
    return d ? { ...d, orderId: id } : null;
  }

  runTransaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const writes: [string, string, Doc][] = [];
      const result = await fn({
        get: async (c, id) => this.read(c, id) ?? null,
        set: (c, id, data) => void writes.push([c, id, clone(data)]),
      });
      for (const [c, id, d] of writes) this.docs.set(`${c}/${id}`, d);
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Inventory view over the same in-memory data (the catalog only reads). */
export function inventoryOf(store: FakeCustomerStore): InventoryStore {
  return {
    get: async (id) => store.read('duo_face_inventory', id) ?? null,
    set: async (id, data) => store.put('duo_face_inventory', id, data),
    listByShopId: async (shopId) =>
      [...store.docs.entries()]
        .filter(([k, d]) => k.startsWith('duo_face_inventory/') && d.shopId === shopId)
        .map(([, d]) => structuredClone(d)),
    runTransaction: async () => {
      throw new Error('not used');
    },
  };
}

export const NOW = new Date('2026-10-06T10:00:00Z');

export function seed(store: FakeCustomerStore, stock = 1) {
  store.put('shops', 'shop-1', { name: 'Kirana One', address: 'MG Road', isOpen: true, isActive: true });
  store.put('products', 'p-milk', { shopId: 'shop-1', name: 'Milk', price: 28.5, inStock: true, isActive: true });
  store.put('products', 'p-bread', { shopId: 'shop-1', name: 'Bread', price: 40, inStock: true, isActive: true });
  for (const [id, qty] of [['p-milk', stock], ['p-bread', 10]] as const) {
    store.put('duo_face_inventory', `shop-1__${id}`, {
      inventoryId: `shop-1__${id}`,
      shopId: 'shop-1',
      productId: id,
      quantity: qty,
      reservedQuantity: 0,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  for (const uid of ['cust-A', 'cust-B']) {
    store.put(`users/${uid}/addresses`, 'addr-1', {
      label: 'Home',
      fullAddress: '12 Park Street, Delhi',
      phoneNumber: '9876543210',
      isDefault: true,
    });
  }
}
