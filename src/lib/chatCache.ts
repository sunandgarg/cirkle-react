const DB_NAME = "cirkle-chat-cache";
const STORE_NAME = "rooms";
const DB_VERSION = 2;
const MAX_MESSAGES_PER_ROOM = 200;

type CachedRoom = {
  cacheKey: string;
  userId: string;
  roomId: string;
  messages: unknown[];
  updatedAt: number;
};

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
};

export const scopedChatCacheKey = (userId: string, roomId: string): string => `${userId}:${roomId}`;

export const getCachedMessages = async <T>(userId: string, roomId: string): Promise<T[]> => {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(scopedChatCacheKey(userId, roomId));
    request.onsuccess = () => resolve((request.result as CachedRoom | undefined)?.messages as T[] || []);
    request.onerror = () => resolve([]);
    transaction.oncomplete = () => db.close();
  });
};

export const cacheMessages = async (userId: string, roomId: string, messages: unknown[]): Promise<void> => {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      cacheKey: scopedChatCacheKey(userId, roomId),
      userId,
      roomId,
      messages: messages.slice(-MAX_MESSAGES_PER_ROOM),
      updatedAt: Date.now(),
    } satisfies CachedRoom);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); resolve(); };
  });
};

export const clearChatCache = async (): Promise<void> => {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key === "cirkle:chat-inbox" || key?.startsWith("cirkle:chat-inbox:")) localStorage.removeItem(key);
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
