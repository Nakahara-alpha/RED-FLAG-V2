// Feature 8 — read-later / link stash
import {
  addReadLater, listReadLater, getReadLater, markRead, deleteReadLater,
} from '../db/queries.js';
import { reply, PREFIX, quotedInfo, getText, fmtDT, paginate } from '../lib/helpers.js';

const URL_RE = /https?:\/\/\S+/i;

async function handleLater(sock, msg, args) {
  const joined = args.join(' ').trim();
  // Scan the WHOLE argument string for a URL, not just args[0] — so
  // `.later check this https://example.com` still finds the link.
  let url = joined.match(URL_RE)?.[0] || null;
  let note = url ? joined.replace(url, '').trim() : null;

  // auto-detect a URL in the replied-to message
  if (!url) {
    const q = quotedInfo(msg);
    const quotedText = q ? getText(q.message) : '';
    url = quotedText.match(URL_RE)?.[0] || null;
    note = joined || null; // when the URL is in the quote, treat the typed args as the note
  }
  if (!url) return reply(sock, msg, `Usage: *${PREFIX()}later <url> [note]* — or reply to a message containing a link.`);

  const id = addReadLater(url, note || null);
  return reply(sock, msg, `🔖 Stashed *#${id}*${note ? ` — "${note}"` : ''}. List: *${PREFIX()}readlist*`);
}

async function handleReadlist(sock, msg, args) {
  let page = 1, unreadOnly = false;
  for (const a of args) {
    if (/^\d+$/.test(a)) page = parseInt(a, 10);
    else if (a.toLowerCase() === 'unread') unreadOnly = true;
  }
  const rows = listReadLater(unreadOnly);
  if (!rows.length) return reply(sock, msg, unreadOnly ? '🔖 Nothing unread. 🎉' : `🔖 Stash is empty. Save: *${PREFIX()}later <url>*`);
  const { slice, page: p, pages, total } = paginate(rows, page, 8);
  const lines = slice.map(r =>
    `${r.read ? '✅' : '🔵'} *#${r.id}* ${r.url.length > 60 ? r.url.slice(0, 60) + '…' : r.url}` +
    `${r.note ? `\n   📝 ${r.note}` : ''}\n   _${fmtDT(r.ts)}_`);
  // Carry the unread filter into the next-page hint so paging doesn't silently
  // drop it (and so the user knows how to get page 2 at all).
  const more = p < pages ? `\n*${PREFIX()}readlist ${unreadOnly ? 'unread ' : ''}${p + 1}* → more` : '';
  return reply(sock, msg,
    `🔖 *Read later${unreadOnly ? ' (unread)' : ''}* (${total}) — page ${p}/${pages}\n\n${lines.join('\n')}\n\n` +
    `*${PREFIX()}read <id>* to open · *${PREFIX()}readdone <id>* when finished${more}`);
}

async function handleRead(sock, msg, args) {
  const id = parseInt(args[0], 10);
  const r = id ? getReadLater(id) : null;
  if (!r) return reply(sock, msg, `Usage: *${PREFIX()}read <id>* (see *${PREFIX()}readlist*)`);
  return reply(sock, msg, `🔖 *#${r.id}*${r.note ? ` — ${r.note}` : ''}\n${r.url}`);
}

async function handleReadDone(sock, msg, args) {
  const id = parseInt(args[0], 10);
  if (!id) return reply(sock, msg, `Usage: *${PREFIX()}readdone <id>* (or *${PREFIX()}readdel <id>* to delete)`);
  const n = markRead(id);
  return reply(sock, msg, n ? `✅ #${id} marked read.` : `⚠️ No unread item #${id}.`);
}

async function handleReadDel(sock, msg, args) {
  const n = deleteReadLater(parseInt(args[0], 10) || 0);
  return reply(sock, msg, n ? '🗑️ Removed from stash.' : `Usage: *${PREFIX()}readdel <id>*`);
}

export const commands = [
  { name: 'later', execute: handleLater },
  { name: 'readlist', execute: handleReadlist },
  { name: 'read', execute: handleRead },
  { name: 'readdone', execute: handleReadDone },
  { name: 'readdel', execute: handleReadDel },
];
