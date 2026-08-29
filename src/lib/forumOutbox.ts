export type ForumOutboxFile = {
  blob: Blob;
  name: string;
  type: string;
  lastModified?: number;
};

export type ForumOutboxItem = {
  id: string;
  userId: string;
  scopeType: string;
  scopeKey: string;
  content: string;
  isAnonymous: boolean;
  replyToId: string | null;
  createdAt: string;
  image?: ForumOutboxFile | null;
  file?: ForumOutboxFile | null;
  imageUrl?: string | null;
  imagePath?: string | null;
  voiceUrl?: string | null;
  voicePath?: string | null;
  voiceDuration?: number | null;
  pollQuestion?: string;
  pollOptions?: string[];
  attempts: number;
  nextAttemptAt: number;
  lastError?: string | null;
};

const DB_NAME = "cirkle-forum-outbox";
const STORE_NAME = "posts";
const DB_VERSION = 1;
const EVENT_NAME = "cirkle:forum-outbox";

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable"));
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("userId", "userId", { unique: false });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Could not open the message outbox"));
});

const notify = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT_NAME));
};

export const putForumOutboxItem = async (item: ForumOutboxItem) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save the message for retry"));
  });
  db.close();
  notify();
};

export const deleteForumOutboxItem = async (id: string) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not clear the delivered message"));
  });
  db.close();
  notify();
};

export const listForumOutboxItems = async (userId: string): Promise<ForumOutboxItem[]> => {
  const db = await openDb();
  const result = await new Promise<ForumOutboxItem[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).index("userId").getAll(userId);
    request.onsuccess = () => resolve((request.result || []) as ForumOutboxItem[]);
    request.onerror = () => reject(request.error || new Error("Could not read the message outbox"));
  });
  db.close();
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

export const markForumOutboxFailed = async (item: ForumOutboxItem, error: unknown) => {
  const attempts = item.attempts + 1;
  const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6)));
  await putForumOutboxItem({
    ...item,
    attempts,
    nextAttemptAt: Date.now() + delay,
    lastError: error instanceof Error ? error.message : "Delivery failed",
  });
};

export const subscribeForumOutbox = (listener: () => void) => {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
};
