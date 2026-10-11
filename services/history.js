// Backfill: persist WhatsApp's own message history into msg_cache so .summarize,
// NEXUS context and group activity can see messages from BEFORE the bot launched.
//
// How WhatsApp history works (verified against the Baileys fork's source):
//   • The phone pushes history in chunks via the `messaging-history.set` event.
//   • A big "bootstrap" dump is only requested at PAIRING time (the full-sync flag
//     rides in the registration node, which is only built when there are no creds).
//     So a brand-new link backfills a lot; a plain restart backfills nothing.
//   • `sock.fetchMessageHistory(count, oldestKey, oldestTs)` asks for more ON DEMAND
//     at any time. Results come back through the SAME event (syncType ON_DEMAND).
//   • Baileys DISCARDS every history payload unless shouldSyncHistoryMessage is
//     true — that gate is why this was silently dead before.
//
// HARD LIMIT: WhatsApp sets supportGroupHistory=false (in this fork and upstream),
// so it only ships DM history. Group backfill is refused by the server, not by us.
import { cacheMsg } from '../db/queries.js';
import { contentTypeOf, getText } from '../lib/helpers.js';

export function historyEnabled() {
  return process.env.HISTORY_SYNC !== '0';
}

// A history message's sender: in groups it's the participant, in DMs the chat jid
// (or us when fromMe). History keys don't carry pushName, so names fill in later
// from live messages.
function historySender(m) {
  const k = m.key || {};
  return k.participant || m.participant || k.remoteJid || null;
}

/**
 * Persist one `messaging-history.set` payload. Returns how many rows were stored.
 * Deliberately defensive: a malformed history entry must never kill the socket.
 */
export function ingestHistory({ messages = [] } = {}) {
  let n = 0;
  for (const m of messages) {
    try {
      if (!m?.key?.id || !m.key.remoteJid) continue;
      const text = getText(m.message) || null;
      const type = m.message ? contentTypeOf(m.message) : null;
      if (!text && !type) continue;                       // nothing worth storing
      // Use the message's OWN timestamp, not now() — otherwise years-old messages
      // sort as if they just arrived and .summarize/activity read backwards.
      const tsSec = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
      cacheMsg({
        msg_id: m.key.id,
        chat_id: m.key.remoteJid,
        sender: historySender(m),
        push_name: m.pushName || null,
        type,
        content: text,
        media_path: null,                                  // history media isn't downloaded
        from_me: m.key.fromMe ? 1 : 0,
        ts: tsSec > 0 ? tsSec * 1000 : Date.now(),
      });
      n++;
    } catch { /* skip the bad row, keep the rest */ }
  }
  return n;
}

/** Wire the history listener onto a socket. Safe to call on every (re)connect. */
export function attachHistorySync(sock) {
  if (!historyEnabled()) return;
  sock.ev.on('messaging-history.set', (payload) => {
    try {
      const stored = ingestHistory(payload);
      if (stored) {
        const kind = payload?.syncType != null ? ` type=${payload.syncType}` : '';
        const prog = payload?.progress != null ? ` ${payload.progress}%` : '';
        console.log(`[RF] history: stored ${stored} message(s)${kind}${prog}`);
      }
    } catch (e) {
      console.error('[RF] history ingest failed:', e.message);
    }
  });
}
