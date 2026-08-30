export type ChatOutboxItem = {
  id: string;
  userId: string;
  roomId: string;
  content: string;
  createdAt: string;
  messageType: "text" | "image" | "voice";
  replyToMessageId?: string | null;
  media?: { blob: Blob; name: string; type: string } | null;
  mediaPath?: string | null;
  mediaUrl?: string | null;
  voiceDuration?: number | null;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string | null;
};

const DB_NAME = "cirkle-chat-outbox";
const STORE_NAME = "messages";
const EVENT_NAME = "cirkle:chat-outbox";

const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("userId", "userId", { unique: false });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Could not open the chat outbox"));
});

const notify = () => window.dispatchEvent(new Event(EVENT_NAME));

export const putChatOutboxItem = async (item: ChatOutboxItem) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save this chat message for retry"));
  });
  db.close();
  notify();
};

export const deleteChatOutboxItem = async (id: string) => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not clear the delivered chat message"));
  });
  db.close();
  notify();
};

export const listChatOutboxItems = async (userId: string): Promise<ChatOutboxItem[]> => {
  const db = await openDb();
  const items = await new Promise<ChatOutboxItem[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).index("userId").getAll(userId);
    request.onsuccess = () => resolve((request.result || []) as ChatOutboxItem[]);
    request.onerror = () => reject(request.error || new Error("Could not read the chat outbox"));
  });
  db.close();
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
};

export const markChatOutboxFailed = async (item: ChatOutboxItem, error: unknown) => {
  const attempts = item.attempts + 1;
  await putChatOutboxItem({
    ...item,
    attempts,
    nextAttemptAt: Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6)),
    lastError: error instanceof Error ? error.message : "Delivery failed",
  });
};

export const subscribeChatOutbox = (listener: () => void) => {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
};

export const clearChatOutbox = async () => {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
};
