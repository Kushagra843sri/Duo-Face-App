import type { InboxStore } from '../../src/integrations/firebase/FirestoreInboxStore';
import type { NotificationDeviceStore } from '../../src/integrations/firebase/FirestoreNotificationStores';

type Doc = Record<string, unknown>;

/** In-memory per-person inbox (same rules as the Firestore one: create-if-absent, newest first). */
export class FakeInbox implements InboxStore {
  rows = new Map<string, Map<string, Doc>>();
  failCreate = false;
  private box(uid: string) {
    if (!this.rows.has(uid)) this.rows.set(uid, new Map());
    return this.rows.get(uid)!;
  }
  async create(uid: string, id: string, data: Doc) {
    if (this.failCreate) throw new Error('down');
    const box = this.box(uid);
    if (box.has(id)) return false;
    box.set(id, { ...data });
    return true;
  }
  async list(uid: string, limit: number) {
    return [...this.box(uid).entries()]
      .map(([id, d]): Doc => ({ ...d, id }))
      .sort((a, b) => ((b.createdAt as Date | undefined)?.getTime() ?? 0) - ((a.createdAt as Date | undefined)?.getTime() ?? 0))
      .slice(0, limit);
  }
  async unreadCount(uid: string) {
    return [...this.box(uid).values()].filter((d) => d.readAt == null).length;
  }
  async markRead(uid: string, id: string, at: Date) {
    const d = this.box(uid).get(id);
    if (!d) return false;
    if (d.readAt == null) d.readAt = at;
    return true;
  }
  async markAllRead(uid: string, at: Date) {
    let n = 0;
    for (const d of this.box(uid).values()) {
      if (d.readAt == null) {
        d.readAt = at;
        n += 1;
      }
    }
    return n;
  }
}

export function fakeDevices(docs: Doc[]) {
  const store = new Map(docs.map((d) => [String(d.deviceId), d]));
  const impl: NotificationDeviceStore = {
    get: async (id) => store.get(id) ?? null,
    set: async (id, data) => void store.set(id, data),
    listByFirebaseUid: async (uid) => [...store.values()].filter((d) => d.firebaseUid === uid),
    listByPushToken: async () => [],
  };
  return { store, impl };
}
