import { listAlerts, isToggled } from '../db/queries.js';
import { senderJid, jidNum, dmOwner, groupMeta } from '../lib/helpers.js';

// HARDEN #8: same keyword in the same chat DMs the owner at most once per window
const DEBOUNCE_MS = 5 * 60 * 1000;
const lastAlert = new Map(); // `${chatId}|${keyword}` → ts

/** DM the owner when a watched keyword appears. Per-chat opt-in (HARDEN #3). */
export function checkKeywordAlerts(sock, msg, body) {
  const chatId = msg.key.remoteJid;
  if (!isToggled(chatId, 'alerts', false)) return;

  const keywords = listAlerts();
  if (!keywords.length) return;
  const lower = body.toLowerCase();
  const hit = keywords.find(k => lower.includes(k));
  if (!hit) return;

  const key = `${chatId}|${hit}`;
  const now = Date.now();
  // Prune expired debounce entries so this map stays bounded over long uptimes.
  for (const [k, ts] of lastAlert) if (now - ts > DEBOUNCE_MS) lastAlert.delete(k);
  if (now - (lastAlert.get(key) || 0) < DEBOUNCE_MS) return;
  lastAlert.set(key, now);

  (async () => {
    try {
      let subject = 'a group';
      try { subject = (await groupMeta(sock, chatId)).subject; } catch { /* keep default */ }
      const who = `${msg.pushName || 'Unknown'} (+${jidNum(senderJid(msg, sock))})`;
      const snippet = body.length > 300 ? body.slice(0, 300) + '…' : body;
      await dmOwner(sock,
        `🔔 *Keyword alert:* "${hit}"\n👥 ${subject}\n👤 ${who}\n\n💬 ${snippet}`);
    } catch (err) {
      console.error('[RF] keyword alert failed:', err.message);
    }
  })();
}
