/**
 * Owns one optional compatibility channel. Retirement clears ownership and
 * health synchronously before the asynchronous provider cleanup begins, so a
 * late SUBSCRIBED/CLOSED callback from the old channel cannot revive it.
 */
export function createRealtimeFallbackSlot<T>(remove: (channel: T) => unknown) {
  let current: T | null = null;
  let healthy = false;

  const retire = () => {
    const previous = current;
    current = null;
    healthy = false;
    if (previous === null) return false;
    try {
      void Promise.resolve(remove(previous)).catch(() => undefined);
    } catch {
      // Provider cleanup is best-effort after synchronous local retirement.
    }
    return true;
  };

  return {
    attach: (channel: T) => {
      if (current !== null) return false;
      current = channel;
      healthy = false;
      return true;
    },
    hasChannel: () => current !== null,
    isCurrent: (channel: T) => current === channel,
    isHealthy: () => healthy,
    markHealthy: (channel: T) => {
      if (current !== channel) return false;
      healthy = true;
      return true;
    },
    retire,
  };
}

/**
 * AppSync replaces only durable message delivery. Typing remains on the
 * dedicated, membership-authorized `chat:*` Socket.IO channel, so attaching a
 * `room-*` database fallback must not split typing traffic between clients.
 * Socket-only mode retains its historical behavior and uses the fallback when
 * the combined chat channel is unavailable.
 */
export function selectChatTypingChannel<T>(
  appSyncEnabled: boolean,
  dedicatedChannel: T | null,
  fallbackChannel: T | null,
): T | null {
  return appSyncEnabled ? dedicatedChannel : fallbackChannel ?? dedicatedChannel;
}
