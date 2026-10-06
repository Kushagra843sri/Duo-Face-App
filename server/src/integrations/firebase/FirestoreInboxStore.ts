import { INBOX_COLLECTION } from '../../types/notifications';
import { getFirebaseAdminApp } from './firebaseAdmin';

type Doc = Record<string, unknown>;

/**
 * Per-recipient in-app notification inbox: duo_face_inbox/{uid}/items/{id}.
 * A subcollection per user keeps "newest first" a single-field query (no
 * composite index) and makes one user's items unreachable from another's path.
 */
export interface InboxStore {
  /** Creates the item; false if it already exists (that is the de-duplication). */
  create(uid: string, id: string, data: Doc): Promise<boolean>;
  /** Newest first. */
  list(uid: string, limit: number): Promise<Doc[]>;
  unreadCount(uid: string): Promise<number>;
  /** false when the item does not exist. */
  markRead(uid: string, id: string, at: Date): Promise<boolean>;
  markAllRead(uid: string, at: Date): Promise<number>;
}

const MAX_UNREAD_SCAN = 200;

export class FirestoreInboxStore implements InboxStore {
  private async items(uid: string) {
    const { getFirestore } = await import('firebase-admin/firestore');
    return getFirestore(getFirebaseAdminApp()).collection(INBOX_COLLECTION).doc(uid).collection('items');
  }

  async create(uid: string, id: string, data: Doc): Promise<boolean> {
    try {
      await (await this.items(uid)).doc(id).create(data);
      return true;
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (code === 6 || code === 'already-exists') return false; // gRPC ALREADY_EXISTS
      throw err;
    }
  }

  async list(uid: string, limit: number): Promise<Doc[]> {
    const snap = await (await this.items(uid)).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }

  async unreadCount(uid: string): Promise<number> {
    const snap = await (await this.items(uid)).where('readAt', '==', null).limit(MAX_UNREAD_SCAN).get();
    return snap.size;
  }

  async markRead(uid: string, id: string, at: Date): Promise<boolean> {
    const ref = (await this.items(uid)).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    if (snap.data()?.readAt == null) await ref.update({ readAt: at });
    return true;
  }

  async markAllRead(uid: string, at: Date): Promise<number> {
    const col = await this.items(uid);
    const snap = await col.where('readAt', '==', null).limit(MAX_UNREAD_SCAN).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ readAt: at })));
    return snap.size;
  }
}
