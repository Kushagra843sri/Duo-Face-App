/**
 * An in-memory stand-in for `firebase-admin/firestore`, used by the end-to-end
 * tests so the REAL server (routes, services, stores) runs unchanged against
 * a fake database. It models only what the server uses: collections and
 * sub-collections, doc get/set/update/create/delete, equality `where`,
 * `orderBy` + `limit`, and transactions (serialised, writes applied on
 * commit). Like real Firestore, reads return Timestamp objects (not Dates),
 * so code that wrongly assumes `Date` is caught here.
 */

export class FakeTimestamp {
  constructor(private readonly ms: number) {}
  toDate(): Date {
    return new Date(this.ms);
  }
  toMillis(): number {
    return this.ms;
  }
}

const SERVER_TIMESTAMP = Symbol('serverTimestamp');

export const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
};

export const Timestamp = {
  fromDate: (d: Date) => new FakeTimestamp(d.getTime()),
  now: () => new FakeTimestamp(Date.now()),
};

type Data = Record<string, unknown>;

/** Writes: Dates / Timestamps / server timestamps become stored Dates. */
function toStored(value: unknown): unknown {
  if (value === SERVER_TIMESTAMP) return new Date();
  if (value instanceof FakeTimestamp) return new Date(value.toMillis());
  if (Object.prototype.toString.call(value) === '[object Date]') return new Date((value as Date).getTime());
  if (Array.isArray(value)) return value.map(toStored);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Data).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toStored(v)]));
  }
  return value;
}

/** Reads: stored Dates come back as Timestamps, deep-copied so callers cannot mutate the store. */
function toRead(value: unknown): unknown {
  if (Object.prototype.toString.call(value) === '[object Date]') return new FakeTimestamp((value as Date).getTime());
  if (Array.isArray(value)) return value.map(toRead);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Data).map(([k, v]) => [k, toRead(v)]));
  return value;
}

function getPath(data: Data, path: string): { exists: boolean; value: unknown } {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in (cur as Data))) return { exists: false, value: undefined };
    cur = (cur as Data)[part];
  }
  return { exists: true, value: cur };
}

const millis = (v: unknown): number => (Object.prototype.toString.call(v) === '[object Date]' ? (v as Date).getTime() : Number(v));

let autoId = 0;

export class FakeDb {
  docs = new Map<string, Data>();
  private chain: Promise<unknown> = Promise.resolve();

  reset() {
    this.docs.clear();
    this.chain = Promise.resolve();
  }

  collection(path: string) {
    return new FakeCollection(this, path);
  }

  /** Test helpers (not part of the Firestore API). */
  put(path: string, data: Data) {
    this.docs.set(path, toStored(data) as Data);
  }
  read(path: string): Data | undefined {
    const d = this.docs.get(path);
    return d ? (toRead(d) as Data) : undefined;
  }
  list(collectionPath: string): { id: string; data: Data }[] {
    return this.idsIn(collectionPath).map((id) => ({ id, data: toRead(this.docs.get(`${collectionPath}/${id}`)!) as Data }));
  }

  idsIn(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
  }

  runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const tx = new FakeTransaction(this);
      const result = await fn(tx);
      tx.commit();
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export class FakeDocRef {
  readonly id: string;
  constructor(
    readonly db: FakeDb,
    readonly path: string
  ) {
    this.id = path.split('/').pop()!;
  }

  snapshot(): FakeSnapshot {
    const stored = this.db.docs.get(this.path);
    return new FakeSnapshot(this, stored ? (toRead(stored) as Data) : null);
  }

  async get() {
    return this.snapshot();
  }

  async set(data: Data, options?: { merge?: boolean }) {
    const next = toStored(data) as Data;
    this.db.docs.set(this.path, options?.merge ? { ...(this.db.docs.get(this.path) ?? {}), ...next } : next);
  }

  async update(data: Data) {
    const current = this.db.docs.get(this.path);
    if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
    this.db.docs.set(this.path, { ...current, ...(toStored(data) as Data) });
  }

  async create(data: Data) {
    if (this.db.docs.has(this.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
    this.db.docs.set(this.path, toStored(data) as Data);
  }

  async delete() {
    this.db.docs.delete(this.path);
  }

  collection(name: string) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
}

export class FakeSnapshot {
  constructor(
    readonly ref: FakeDocRef,
    private readonly value: Data | null
  ) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.value !== null;
  }
  data(): Data | undefined {
    return this.value ?? undefined;
  }
}

export class FakeQuerySnapshot {
  constructor(readonly docs: FakeSnapshot[]) {}
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
}

interface Filter {
  field: string;
  value: unknown;
}

export class FakeQuery {
  constructor(
    protected readonly db: FakeDb,
    protected readonly collectionPath: string,
    private readonly filters: Filter[] = [],
    private readonly order: { field: string; dir: 'asc' | 'desc' } | null = null,
    private readonly max: number | null = null
  ) {}

  where(field: string, op: string, value: unknown) {
    if (op !== '==') throw new Error(`FakeFirestore supports only '==' (got ${op})`);
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, { field, value }], this.order, this.max);
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.db, this.collectionPath, this.filters, { field, dir }, this.max);
  }
  limit(n: number) {
    return new FakeQuery(this.db, this.collectionPath, this.filters, this.order, n);
  }

  run(): FakeQuerySnapshot {
    let rows = this.db.idsIn(this.collectionPath).map((id) => ({ id, data: this.db.docs.get(`${this.collectionPath}/${id}`)! }));
    for (const f of this.filters) {
      rows = rows.filter((r) => {
        const got = getPath(r.data, f.field);
        // Firestore: `== null` matches only fields that exist and are null.
        if (f.value === null) return got.exists && got.value === null;
        return got.exists && got.value === f.value;
      });
    }
    if (this.order) {
      const { field, dir } = this.order;
      rows = rows.filter((r) => getPath(r.data, field).exists); // ordered queries exclude docs lacking the field
      rows.sort((a, b) => (millis(getPath(a.data, field).value) - millis(getPath(b.data, field).value)) * (dir === 'desc' ? -1 : 1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    return new FakeQuerySnapshot(rows.map((r) => new FakeDocRef(this.db, `${this.collectionPath}/${r.id}`).snapshot()));
  }

  async get() {
    return this.run();
  }
}

export class FakeCollection extends FakeQuery {
  constructor(db: FakeDb, path: string) {
    super(db, path);
  }
  doc(id?: string) {
    return new FakeDocRef(this.db, `${this.collectionPath}/${id ?? `auto${++autoId}x${Math.random().toString(36).slice(2, 8)}`}`);
  }
}

export class FakeTransaction {
  private writes: (() => void)[] = [];
  constructor(private readonly db: FakeDb) {}

  async get(target: FakeDocRef | FakeQuery) {
    return target instanceof FakeDocRef ? target.snapshot() : (target as FakeQuery).run();
  }
  set(ref: FakeDocRef, data: Data, options?: { merge?: boolean }) {
    this.writes.push(() => void ref.set(data, options));
  }
  update(ref: FakeDocRef, data: Data) {
    this.writes.push(() => void ref.update(data));
  }
  create(ref: FakeDocRef, data: Data) {
    this.writes.push(() => void ref.create(data));
  }
  delete(ref: FakeDocRef) {
    this.writes.push(() => void ref.delete());
  }
  commit() {
    for (const w of this.writes) w();
  }
}

export const fakeDb = new FakeDb();

// ---- the module shape `firebase-admin/firestore` exposes to the server ----
export const getFirestore = () => ({
  collection: (path: string) => fakeDb.collection(path),
  runTransaction: <T>(fn: (tx: FakeTransaction) => Promise<T>) => fakeDb.runTransaction(fn),
});
