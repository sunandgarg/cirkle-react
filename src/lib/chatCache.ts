const DB_NAME = "cirkle-chat-cache";
const STORE_NAME = "rooms";
const DB_VERSION = 1;
const MAX_MESSAGES_PER_ROOM = 200;

type CachedRoom = {
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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "roomId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
};

export const getCachedMessages = async <T>(roomId: string): Promise<T[]> => {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(roomId);
    request.onsuccess = () => resolve((request.result as CachedRoom | undefined)?.messages as T[] || []);
    request.onerror = () => resolve([]);
    transaction.oncomplete = () => db.close();
  });
};

export const cacheMessages = async (roomId: string, messages: unknown[]): Promise<void> => {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      roomId,
      messages: messages.slice(-MAX_MESSAGES_PER_ROOM),
      updatedAt: Date.now(),
    } satisfies CachedRoom);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); resolve(); };
  });
};

export const clearChatCache = async (): Promise<void> => {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
