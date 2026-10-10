import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc.js';
import { downloadMediaMessage } from '@innovatorssoft/baileys';
import { GLOBAL, getConfig } from '../db/queries.js';

dayjs.extend(utcPlugin);

export const BOT_NAME = () => process.env.BOT_NAME || '𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2';
// Prefix: DB-config first (set with the prefix command, survives restarts),
// then PREFIX env, then '.'
export const PREFIX = () => getConfig(GLOBAL, 'prefix', null) || process.env.PREFIX || '.';

// ── timezone: all user-facing times are WAT (UTC+1, no DST) — HARDEN #2 ──────
// DB stores absolute UTC epochs; this is the ONE place the offset lives.
export const TZ_OFFSET_MIN = (() => {
  const n = parseInt(process.env.TZ_OFFSET_MIN, 10);
  return Number.isFinite(n) ? n : 60; // Africa/Lagos
})();
/** A dayjs instance pinned to WAT, regardless of server timezone. */
export function wat(ts) {
  return (ts === undefined ? dayjs() : dayjs(ts)).utc().utcOffset(TZ_OFFSET_MIN);
}

// ── identity ─────────────────────────────────────────────────────────────────
export function jidNum(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
export function ownerNumbers() {
  return (process.env.OWNER_NUMBER || '').split(',').map(s => s.trim()).filter(Boolean);
}
export function ownerJid(sock) {
  return jidNum(sock.user.id) + '@s.whatsapp.net';
}
export function senderJid(msg, sock) {
  if (msg.key.participant) return msg.key.participant;
  if (msg.key.fromMe && sock?.user?.id) return ownerJid(sock);
  return msg.key.remoteJid;
}

// The real phone-number JID for a message's sender. WhatsApp now addresses some
// chats by LID (e.g. 245882…@lid, which is NOT a phone number) — prefer the
// paired @s.whatsapp.net address carried in the *Alt key fields.
export function senderPhoneJid(msg, sock) {
  const k = msg.key || {};
  if (k.fromMe && sock?.user?.id) return ownerJid(sock);
  const cands = [k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt]
    .filter(j => typeof j === 'string');
  const pn = cands.find(j => j.endsWith('@s.whatsapp.net'));
  return pn || cands[0] || k.remoteJid || null;
}

// Best-effort: turn a possibly-LID jid into a phone-number jid via Baileys'
// LID↔PN mapping (async, may be unavailable — falls back to the input).
export async function resolvePhoneJid(sock, jid) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@lid')) return jid;
  try {
    const map = sock?.signalRepository?.lidMapping;
    const pn = await map?.getPNForLID?.(jid);
    if (pn && typeof pn === 'string') return pn;
  } catch { /* mapping unavailable */ }
  return jid;
}
// The bot runs on the owner's own account, so fromMe === owner.
export function isOwnerMsg(msg, sock) {
  if (msg.key.fromMe) return true;
  const owners = ownerNumbers();
  // Groups increasingly address members by LID, so check BOTH the phone-number
  // form (senderPhoneJid prefers the paired @s.whatsapp.net alt) and the raw
  // participant form against the configured owner numbers. Without the phone
  // form, a secondary owner listed in OWNER_NUMBER goes unrecognized in any
  // LID-addressed group (the primary owner still matches via fromMe).
  if (owners.includes(jidNum(senderPhoneJid(msg, sock)))) return true;
  const raw = jidNum(senderJid(msg, sock));
  if (owners.includes(raw)) return true;
  if (sock?.user?.lid && raw === jidNum(sock.user.lid)) return true;
  return false;
}

// ── group metadata (cached briefly) ──────────────────────────────────────────
// Short TTL: this cache backs admin/owner authorization checks (isGroupAdmin /
// botIsAdmin), so a long TTL would let a just-demoted admin keep using admin
// tools. 60s balances freshness against re-fetching metadata on every command.
const META_TTL_MS = 60 * 1000;
const metaCache = new Map();
export async function groupMeta(sock, chatId) {
  const hit = metaCache.get(chatId);
  if (hit && Date.now() - hit.ts < META_TTL_MS) return hit.meta;
  const meta = await sock.groupMetadata(chatId);
  metaCache.set(chatId, { meta, ts: Date.now() });
  // Evict stale entries so the map doesn't retain every group ever seen.
  if (metaCache.size > 50) {
    const cutoff = Date.now() - META_TTL_MS;
    for (const [k, v] of metaCache) if (v.ts < cutoff) metaCache.delete(k);
  }
  return meta;
}
function participantIds(p) {
  return [p.id, p.jid, p.lid].filter(Boolean).map(jidNum);
}
export async function isGroupAdmin(sock, chatId, userJid) {
  try {
    const meta = await groupMeta(sock, chatId);
    const num = jidNum(userJid);
    const p = meta.participants.find(x => participantIds(x).includes(num));
    return !!p?.admin;
  } catch { return false; }
}
export async function botIsAdmin(sock, chatId) {
  try {
    const meta = await groupMeta(sock, chatId);
    const mine = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNum);
    const p = meta.participants.find(x => participantIds(x).some(n => mine.includes(n)));
    return !!p?.admin;
  } catch { return false; }
}

// ── message content ──────────────────────────────────────────────────────────
export function unwrapMessage(message) {
  if (!message) return message;
  return message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.viewOnceMessageV2Extension?.message
    || message;
}
export function isViewOnce(message) {
  if (!message) return false;
  if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) return true;
  const m = message.ephemeralMessage?.message || message;
  return !!(m.imageMessage?.viewOnce || m.videoMessage?.viewOnce || m.audioMessage?.viewOnce);
}
export function getText(message) {
  const m = unwrapMessage(message);
  if (!m) return '';
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || '';
}
export function contentTypeOf(message) {
  const m = unwrapMessage(message);
  if (!m) return 'unknown';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage) return 'document';
  if (m.conversation || m.extendedTextMessage) return 'text';
  return 'other';
}
export function quotedInfo(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  // prefer the phone-number jid over a LID for the quoted sender
  const participant = [ctx.participantAlt, ctx.participant]
    .find(j => typeof j === 'string' && j.endsWith('@s.whatsapp.net')) || ctx.participant;
  return {
    message: ctx.quotedMessage,
    stanzaId: ctx.stanzaId,
    participant,
  };
}

// ── media download ───────────────────────────────────────────────────────────
export async function downloadFromMsg(msg) {
  return downloadMediaMessage(msg, 'buffer', {});
}
export async function downloadQuoted(msg) {
  const q = quotedInfo(msg);
  if (!q) return null;
  const fake = {
    key: { remoteJid: msg.key.remoteJid, id: q.stanzaId, participant: q.participant, fromMe: false },
    message: q.message,
  };
  return downloadMediaMessage(fake, 'buffer', {});
}

// ── replies ──────────────────────────────────────────────────────────────────
export async function reply(sock, msg, content) {
  const payload = typeof content === 'string' ? { text: content } : content;
  try {
    return await sock.sendMessage(msg.key.remoteJid, payload, { quoted: msg });
  } catch (err) {
    console.error('[RF] reply failed:', err.message);
  }
}
export async function dmOwner(sock, content) {
  const payload = typeof content === 'string' ? { text: content } : content;
  try {
    return await sock.sendMessage(ownerJid(sock), payload);
  } catch (err) {
    console.error('[RF] dmOwner failed:', err.message);
  }
}

// ── time parsing / formatting ────────────────────────────────────────────────
// "10m" "2h30m" "1d" "45s" → ms
export function parseDuration(str) {
  if (!str) return null;
  const clean = String(str).trim().replace(/^\+/, '');
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let ms = 0, matched = false, m;
  while ((m = re.exec(clean)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    ms += n * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 })[m[2].toLowerCase()];
  }
  return matched ? ms : null;
}
// Accepts: "+10m"/"10m", "18:30", "tomorrow 09:00", "2026-07-10 18:30", "10/07 18:30"
// All wall-clock forms resolve in WAT (HARDEN #2).
export function parseWhen(str) {
  if (!str) return null;
  const s = str.trim();
  const dur = parseDuration(s);
  if (dur !== null && /^(\+)?(\d+[dhms])+$/i.test(s.replace(/\s+/g, ''))) return Date.now() + dur;

  const at = (base, hh, mm) => base.hour(hh).minute(mm).second(0).millisecond(0);

  let m = s.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/i);
  if (m) return at(wat().add(1, 'day'), +m[1], +m[2]).valueOf();

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{1,2}):(\d{2})$/);
  if (m) return at(wat().year(+m[1]).month(+m[2] - 1).date(+m[3]), +m[4], +m[5]).valueOf();

  m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/); // DD/MM HH:MM
  if (m) {
    let d = at(wat().month(+m[2] - 1).date(+m[1]), +m[3], +m[4]);
    if (d.valueOf() < Date.now()) d = d.add(1, 'year');
    return d.valueOf();
  }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    let d = at(wat(), +m[1], +m[2]);
    if (d.valueOf() <= Date.now()) d = d.add(1, 'day');
    return d.valueOf();
  }
  // date only → 09:00 WAT
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return at(wat().year(+m[1]).month(+m[2] - 1).date(+m[3]), 9, 0).valueOf();
  return null;
}
export function fmtDT(ts) {
  return wat(ts).format('ddd DD MMM, HH:mm');
}
export function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
export function naira(n) {
  return '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

// ── misc ─────────────────────────────────────────────────────────────────────
export function mentionTag(jid) {
  return '@' + jidNum(jid);
}
export async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
export function paginate(rows, page = 1, per = 10) {
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const p = Math.min(Math.max(1, page), pages);
  return { slice: rows.slice((p - 1) * per, p * per), page: p, pages, total: rows.length };
}

// "8am" "9:30pm" "21:00" → {hh, mm} or null
export function parseClockTime(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// Reject URLs that point at the local machine / private networks before we make
// a server-side request on a third-party-supplied URL (SSRF guard for the
// downloaders, which fetch media URLs returned by scraper APIs). Covers the
// common metadata/loopback/RFC-1918 vectors; a redirect could still bounce to an
// internal host (standard fetch re-follows without re-checking) — acceptable for
// a personal bot given the attacker would need to control the scraper response.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;      // link-local / cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported url scheme');
  if (isPrivateHost(u.hostname)) throw new Error('refusing to fetch a private/internal address');
  return u;
}

export async function fetchBuffer(url, timeoutMs = 60000, maxBytes = 60 * 1024 * 1024) {
  assertSafeUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('file too large');
    return buf;
  } finally { clearTimeout(t); }
}
