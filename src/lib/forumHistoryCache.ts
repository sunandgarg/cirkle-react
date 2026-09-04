export type CachedForumPost = Record<string, unknown> & {
  id: string;
  created_at?: string | null;
};

const DB_NAME = "cirkle-forum-history";
const DB_VERSION = 1;
const STORE_NAME = "rooms";
export const MAX_ROOM_HISTORY = 1_200;
const MAX_CACHED_ROOMS = 12;

type RoomHistory = {
  roomKey: string;
  updatedAt: number;
  posts: CachedForumPost[];
};

const roomKey = (viewerId: string, scopeType: string, scopeKey: string) =>
  `${viewerId}:${scopeType}:${scopeKey}`;

export const mergeForumHistoryPosts = <T extends CachedForumPost>(
  existing: T[],
  incoming: T[],
  limit = MAX_ROOM_HISTORY,
): T[] => {
  const byId = new Map(existing.map((post) => [post.id, post]));
  for (const post of incoming) {
    const previous = byId.get(post.id);
    byId.set(post.id, previous ? { ...previous, ...post } : post);
  }
  return [...byId.values()]
    .sort((left, right) => {
      const byTime = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
      return byTime || left.id.localeCompare(right.id);
    })
    .slice(-limit);
};

const openHistoryDb = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "roomKey" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T | null> =>
  new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });

const oldestRoomKeys = (db: IDBDatabase, limit: number): Promise<string[]> =>
  new Promise((resolve) => {
    if (limit <= 0) {
      resolve([]);
      return;
    }
    const keys: string[] = [];
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const request = store.index("updatedAt").openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || keys.length >= limit) {
        resolve(keys);
        return;
      }
      keys.push(String(cursor.primaryKey));
      cursor.continue();
    };
    request.onerror = () => resolve(keys);
  });

export const readForumHistory = async <T extends CachedForumPost>(
  viewerId: string,
  scopeType: string,
  scopeKey: string,
): Promise<T[]> => {
  const db = await openHistoryDb();
  if (!db) return [];
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const row = await requestResult(transaction.objectStore(STORE_NAME).get(roomKey(viewerId, scopeType, scopeKey))) as RoomHistory | null;
    return Array.isArray(row?.posts) ? row.posts as T[] : [];
  } finally {
    db.close();
  }
};

const writeQueues = new Map<string, Promise<void>>();

export const persistForumHistory = <T extends CachedForumPost>(
  viewerId: string,
  scopeType: string,
  scopeKey: string,
  posts: T[],
) => {
  const key = roomKey(viewerId, scopeType, scopeKey);
  const previous = writeQueues.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    const db = await openHistoryDb();
    if (!db) return;
    try {
      const readTransaction = db.transaction(STORE_NAME, "readonly");
      const stored = await requestResult(readTransaction.objectStore(STORE_NAME).get(key)) as RoomHistory | null;
      const merged = mergeForumHistoryPosts((stored?.posts || []) as T[], posts);
      const writeTransaction = db.transaction(STORE_NAME, "readwrite");
      const store = writeTransaction.objectStore(STORE_NAME);
      store.put({ roomKey: key, updatedAt: Date.now(), posts: merged } satisfies RoomHistory);
      await transactionDone(writeTransaction);

      const listTransaction = db.transaction(STORE_NAME, "readonly");
      const listStore = listTransaction.objectStore(STORE_NAME);
      const roomCount = await requestResult(listStore.count()) || 0;
      if (roomCount > MAX_CACHED_ROOMS) {
        // Read only the oldest keys. getAll() cloned every cached post in every
        // room onto the main thread and could briefly stall an active timeline.
        const keysToEvict = await oldestRoomKeys(db, roomCount - MAX_CACHED_ROOMS);
        const evictionTransaction = db.transaction(STORE_NAME, "readwrite");
        const evictionStore = evictionTransaction.objectStore(STORE_NAME);
        keysToEvict.forEach((oldestKey) => evictionStore.delete(oldestKey));
        await transactionDone(evictionTransaction);
      }
    } finally {
      db.close();
    }
  }).catch(() => undefined).finally(() => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  });
  writeQueues.set(key, next);
  return next;
};

export const clearForumHistoryCache = async (): Promise<void> => {
  writeQueues.clear();
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
