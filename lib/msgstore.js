// Tiny bounded in-memory store of recent message protos, keyed by message id.
// Baileys calls the socket's getMessage() when a recipient couldn't decrypt a
// message and requests a retry — without it, undelivered messages sit forever
// as "Waiting for this message. This may take a while." (esp. in self-chat).
const store = new Map();
const MAX = 2000;

export function remember(key, message) {
  if (!key?.id || !message) return;
  // Delete-before-set so a re-remembered id moves to the newest position in the
  // Map's insertion order — otherwise it could be evicted as "oldest" despite
  // being freshly seen.
  if (store.has(key.id)) store.delete(key.id);
  store.set(key.id, message);
  if (store.size > MAX) store.delete(store.keys().next().value); // drop oldest
}

export function recall(id) {
  return id ? store.get(id) : undefined;
}

// NodeCache-compatible shim for Baileys' msgRetryCounterCache — counting retry
// receipts lets Baileys force a FRESH session + resend when a recipient fails
// to decrypt, instead of the message rotting as "Waiting for this message…".
// Honors the TTL (seconds) Baileys passes to set() so counters actually expire.
export function makeCounterCache() {
  const m = new Map();
  const live = (k) => {
    const e = m.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp <= Date.now()) { m.delete(k); return undefined; }
    return e;
  };
  return {
    get: (k) => live(k)?.v,
    set: (k, v, ttlSeconds) => { m.set(k, { v, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 }); return true; },
    del: (k) => m.delete(k),
    flushAll: () => m.clear(),
  };
}
