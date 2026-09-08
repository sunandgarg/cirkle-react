const DB_NAME = "cirkle-chat-cache";
const STORE_NAME = "rooms";
const DB_VERSION = 3;
const MAX_MESSAGES_PER_ROOM = 200;
const MAX_CACHED_ROOMS = 24;
const WRITE_DELAY_MS = 800;

type CachedRoom = {
  cacheKey: string;
  userId: string;
  roomId: string;
  messages: unknown[];
  updatedAt: number;
};

type PendingWrite = CachedRoom & {
  timer: ReturnType<typeof setTimeout> | null;
};

const memoryRooms = new Map<string, CachedRoom>();
const pendingWrites = new Map<string, PendingWrite>();
const writeQueues = new Map<string, Promise<void>>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
      if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      resolve(null);
    };
  });
  return databasePromise;
};

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => resolve();
  transaction.onabort = () => resolve();
});

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T | null>((resolve) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => resolve(null);
});

const remember = (room: CachedRoom) => {
  memoryRooms.delete(room.cacheKey);
  memoryRooms.set(room.cacheKey, room);
  while (memoryRooms.size > MAX_CACHED_ROOMS) {
    const oldest = memoryRooms.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryRooms.delete(oldest);
  }
};

const evictOldRooms = async (db: IDBDatabase) => {
  const countTransaction = db.transaction(STORE_NAME, "readonly");
  const count = await requestResult(countTransaction.objectStore(STORE_NAME).count()) || 0;
  if (count <= MAX_CACHED_ROOMS) return;
  const keys: string[] = [];
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index("updatedAt").openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || keys.length >= count - MAX_CACHED_ROOMS) {
        resolve();
        return;
      }
      keys.push(String(cursor.primaryKey));
      cursor.continue();
    };
    request.onerror = () => resolve();
  });
  if (!keys.length) return;
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  keys.forEach((key) => store.delete(key));
  await transactionDone(transaction);
};

const persistRoom = (room: CachedRoom): Promise<void> => {
  const previous = writeQueues.get(room.cacheKey) || Promise.resolve();
  const next = previous.then(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(room);
    await transactionDone(transaction);
    await evictOldRooms(db);
  }).catch(() => undefined).finally(() => {
    if (writeQueues.get(room.cacheKey) === next) writeQueues.delete(room.cacheKey);
  });
  writeQueues.set(room.cacheKey, next);
  return next;
};

export const scopedChatCacheKey = (userId: string, roomId: string): string => `${userId}:${roomId}`;

const roomSnapshot = (userId: string, roomId: string, messages: unknown[]): CachedRoom => ({
  cacheKey: scopedChatCacheKey(userId, roomId),
  userId,
  roomId,
  messages: boundedChatCacheMessages(messages),
  updatedAt: Date.now(),
});

export const boundedChatCacheMessages = <T>(messages: T[]): T[] =>
  messages.slice(-MAX_MESSAGES_PER_ROOM);

export const getCachedMessages = async <T>(userId: string, roomId: string): Promise<T[]> => {
  const key = scopedChatCacheKey(userId, roomId);
  const inMemory = memoryRooms.get(key);
  if (inMemory) return inMemory.messages as T[];
  const db = await openDatabase();
  if (!db) return [];
  const transaction = db.transaction(STORE_NAME, "readonly");
  const row = await requestResult(transaction.objectStore(STORE_NAME).get(key)) as CachedRoom | null;
  if (row) remember(row);
  return (row?.messages as T[] | undefined) || [];
};

/** Immediately persists an authoritative page; routine UI updates use the coalesced scheduler below. */
export const cacheMessages = async (userId: string, roomId: string, messages: unknown[]): Promise<void> => {
  const room = roomSnapshot(userId, roomId, messages);
  remember(room);
  await persistRoom(room);
};

/**
 * Keeps memory current immediately while coalescing rapid message/read-status changes
 * into one IndexedDB write after the interaction settles.
 */
export const scheduleChatCache = (userId: string, roomId: string, messages: unknown[]): void => {
  const room = roomSnapshot(userId, roomId, messages);
  remember(room);
  const previous = pendingWrites.get(room.cacheKey);
  if (previous?.timer) clearTimeout(previous.timer);
  const pending: PendingWrite = { ...room, timer: null };
  pending.timer = setTimeout(() => {
    pendingWrites.delete(room.cacheKey);
    void persistRoom(pending);
  }, WRITE_DELAY_MS);
  pendingWrites.set(room.cacheKey, pending);
};

export const flushChatCache = async (userId?: string, roomId?: string): Promise<void> => {
  const selected = [...pendingWrites.values()].filter((pending) =>
    (!userId || pending.userId === userId) && (!roomId || pending.roomId === roomId));
  selected.forEach((pending) => {
    if (pending.timer) clearTimeout(pending.timer);
    pendingWrites.delete(pending.cacheKey);
  });
  await Promise.all(selected.map((pending) => persistRoom(pending)));
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushChatCache();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void flushChatCache(); });
}

export const clearChatCache = async (): Promise<void> => {
  pendingWrites.forEach((pending) => { if (pending.timer) clearTimeout(pending.timer); });
  pendingWrites.clear();
  memoryRooms.clear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key === "cirkle:chat-inbox" || key?.startsWith("cirkle:chat-inbox:")
        || key?.startsWith("cirkle:direct-message-sidebar:")) localStorage.removeItem(key);
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  if (typeof indexedDB === "undefined") return;
  await Promise.all([...writeQueues.values()]);
  writeQueues.clear();
  const db = await databasePromise;
  db?.close();
  databasePromise = null;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
