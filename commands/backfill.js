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

async function handleBackfill(sock, msg, args) {
  const chatId = msg.key.remoteJid;

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

  const isGroup = chatId.endsWith('@g.us');
  return reply(sock, msg,
    `🕰️ Asked WhatsApp for *${count}* messages before ${fmtDT(seed.ts)}.\n` +
    `📥 They stream in in the background — run *${PREFIX()}backfill status* in a few seconds.\n` +
    `_Currently cached here: ${before} messages._` +
    (isGroup
      ? '\n\n⚠️ Heads up: WhatsApp does *not* serve group history to linked devices, so this usually returns nothing in groups. It works for DMs.'
      : ''));
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
