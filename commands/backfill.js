// .backfill — pull older WhatsApp messages into the bot's cache so .summarize,
// NEXUS context and group activity can reach back before the bot was launched.
//
// It asks WhatsApp (via Baileys' on-demand history sync) for messages OLDER than
// the oldest one we already hold in this chat. Results don't arrive in the reply —
// the phone streams them back asynchronously into msg_cache (services/history.js).
//
// Two limits worth knowing, both WhatsApp's, not ours:
//   • DMs only. The server advertises supportGroupHistory=false, so group history
//     is simply not served. In a group this reports that honestly instead of hanging.
//   • Needs a seed: we must already hold at least one message from the chat to ask
//     "give me what came before this". A chat the bot has never seen can't cold-start.
import { oldestCachedMsg, countCachedMsgs } from '../db/queries.js';
import { reply, PREFIX, fmtDT } from '../lib/helpers.js';
import { historyEnabled } from '../services/history.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleBackfill(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');

  if (!historyEnabled()) {
    return reply(sock, msg, `🕰️ History sync is off. Remove *HISTORY_SYNC=0* from config.env and restart.`);
  }
  if (typeof sock.fetchMessageHistory !== 'function') {
    return reply(sock, msg, '🕰️ This Baileys build has no on-demand history API — can\'t backfill.');
  }

  const count = Math.min(Math.max(parseInt(args[0], 10) || 50, 1), 200);
  const seed = oldestCachedMsg(chatId);
  if (!seed) {
    return reply(sock, msg, '🕰️ I have no messages cached from this chat yet, so there\'s nothing to reach back from. Let a message or two arrive, then try again.');
  }

  const before = countCachedMsgs(chatId);
  try {
    await sock.fetchMessageHistory(
      count,
      { remoteJid: chatId, id: seed.msg_id, fromMe: !!seed.from_me },
      Math.floor(seed.ts / 1000),
    );
  } catch (e) {
    console.error('[RF] backfill request failed:', e.message);
    return reply(sock, msg, `🕰️ WhatsApp refused the history request: ${e.message.slice(0, 120)}`);
  }

  await reply(sock, msg,
    `🕰️ *Backfill started* — asked for ${count} messages before ${fmtDT(seed.ts)}.\n` +
    `📥 Cached here now: *${before}*. Pulling… I'll report when they land.` +
    (isGroup ? '\n\n⚠️ Groups usually return nothing — WhatsApp only serves DM history.' : ''));

  // Messages stream in asynchronously (services/history.js persists them). Poll the
  // cache count until it stops growing, so we can report real progress + completion.
  let last = before, stable = 0, announced = before;
  for (let i = 0; i < 12; i++) {           // ~24s ceiling
    await sleep(2000);
    const n = countCachedMsgs(chatId);
    if (n > last) { last = n; stable = 0; } else { stable++; }
    // One mid-run nudge once a decent batch has landed, so he sees it's working.
    if (last - announced >= 20) {
      announced = last;
      await reply(sock, msg, `⏳ Still pulling… *${last - before}* in so far (total ${last}).`);
    }
    if (stable >= 2) break;                // no growth for ~4s → done
  }

  const gained = last - before;
  const oldest = oldestCachedMsg(chatId);
  if (gained > 0) {
    return reply(sock, msg,
      `✅ *Backfill done.* Pulled *${gained}* older message(s).\n` +
      `📦 This chat now has *${last}* cached, back to *${oldest ? fmtDT(oldest.ts) : '—'}*.`);
  }
  return reply(sock, msg, isGroup
    ? '📭 Nothing came back — WhatsApp doesn\'t serve group history to linked devices. (DMs only.)'
    : '📭 Nothing came back. Either you\'ve reached the start of what WhatsApp will hand over, or your phone was offline. Try again in a bit.');
}

async function handleStatus(sock, msg) {
  const chatId = msg.key.remoteJid;
  const n = countCachedMsgs(chatId);
  const seed = oldestCachedMsg(chatId);
  return reply(sock, msg,
    `🕰️ *Backfill status (this chat)*\n` +
    `• Cached messages: *${n}*\n` +
    `• Oldest reaches back to: *${seed ? fmtDT(seed.ts) : 'nothing cached'}*\n\n` +
    `_${PREFIX()}backfill <count> to pull more (DMs only — WhatsApp won't serve group history)._`);
}

export const commands = [
  {
    name: 'backfill',
    aliases: ['history'],
    execute: async (sock, msg, args) => ((args[0] || '').toLowerCase() === 'status'
      ? handleStatus(sock, msg)
      : handleBackfill(sock, msg, args)),
  },
];
