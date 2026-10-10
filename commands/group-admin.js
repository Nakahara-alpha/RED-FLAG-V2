// Phase 7 — group admin tools (adminOnly: group admins OR owner)
import { wat } from '../lib/helpers.js';
import {
  bumpWarn, getWarns, resetWarns,
  getWelcome, setWelcome,
  bumpStat, topStats, chatHourHistogram,
} from '../db/queries.js';
import {
  reply, PREFIX, groupMeta, botIsAdmin, senderJid, jidNum, mentionTag, getText,
} from '../lib/helpers.js';

function warnLimit() {
  const n = parseInt(process.env.WARN_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function mentionedUser(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    || msg.message?.extendedTextMessage?.contextInfo?.participant // reply target
    || null;
}
function requireGroup(sock, msg) {
  if (!msg.key.remoteJid.endsWith('@g.us')) {
    reply(sock, msg, '⚠️ That only works in groups.');
    return false;
  }
  return true;
}

/** Passive: count group messages for !stats. Called from the pipeline. */
export function logGroupStat(sock, msg) {
  bumpStat(msg.key.remoteJid, jidNum(senderJid(msg, sock)), String(wat().hour()));
}

// ── tagging ──────────────────────────────────────────────────────────────────
async function handleTagAll(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const meta = await groupMeta(sock, msg.key.remoteJid);
  const jids = meta.participants.map(p => p.id);
  const text = args.join(' ').trim() || '📢 Attention everyone!';
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${text}\n\n${jids.map(mentionTag).join(' ')}`,
    mentions: jids,
  }, { quoted: msg });
}

// Hidetag: pings everyone but the mentions stay invisible — only your text shows.
async function handleTag(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const meta = await groupMeta(sock, msg.key.remoteJid);
  const jids = meta.participants.map(p => p.id);
  let text = args.join(' ').trim();
  // if used as a reply with no text, hidetag the quoted message's content
  if (!text) {
    const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    text = q ? getText(q) : '📢';
  }
  await sock.sendMessage(msg.key.remoteJid, { text, mentions: jids }, { quoted: msg });
}

async function handleTagNotAdmin(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const meta = await groupMeta(sock, msg.key.remoteJid);
  const jids = meta.participants.filter(p => !p.admin).map(p => p.id);
  if (!jids.length) return reply(sock, msg, '👥 Everyone here is an admin.');
  const text = args.join(' ').trim() || '📢 Members, attention!';
  await sock.sendMessage(msg.key.remoteJid, {
    text: `${text}\n\n${jids.map(mentionTag).join(' ')}`,
    mentions: jids,
  }, { quoted: msg });
}

// ── warn system ──────────────────────────────────────────────────────────────
async function handleWarn(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const chatId = msg.key.remoteJid;
  const target = mentionedUser(msg);
  if (!target) return reply(sock, msg, `Usage: *${PREFIX()}warn @user [reason]* (mention or reply)`);
  const reason = args.filter(a => !a.startsWith('@')).join(' ').trim();
  const count = bumpWarn(chatId, target);
  const limit = warnLimit();

  if (count >= limit) {
    if (await botIsAdmin(sock, chatId)) {
      try {
        await sock.groupParticipantsUpdate(chatId, [target], 'remove');
        resetWarns(chatId, target);
        return sock.sendMessage(chatId, {
          text: `🥾 ${mentionTag(target)} kicked — reached ${count}/${limit} warnings.`,
          mentions: [target],
        });
      } catch {
        // Bot is admin but the remove still failed (e.g. target is a group
        // admin, or already left). Say so generically rather than claiming a
        // missing-permission reason that isn't the real cause.
        return sock.sendMessage(chatId, {
          text: `⚠️ ${mentionTag(target)} is at ${count}/${limit} warnings but I couldn't remove them.`,
          mentions: [target],
        });
      }
    }
    return sock.sendMessage(chatId, {
      text: `⚠️ ${mentionTag(target)} is at ${count}/${limit} warnings but I need admin rights to kick.`,
      mentions: [target],
    });
  }
  return sock.sendMessage(chatId, {
    text: `⚠️ ${mentionTag(target)} warned (${count}/${limit})${reason ? ` — ${reason}` : ''}. ${limit - count} left before a kick.`,
    mentions: [target],
  });
}

async function handleWarns(sock, msg) {
  if (!requireGroup(sock, msg)) return;
  const target = mentionedUser(msg);
  if (!target) return reply(sock, msg, `Usage: *${PREFIX()}warns @user*`);
  const count = getWarns(msg.key.remoteJid, target);
  return sock.sendMessage(msg.key.remoteJid, {
    text: `⚠️ ${mentionTag(target)} has *${count}/${warnLimit()}* warnings here.`,
    mentions: [target],
  });
}

async function handleResetWarn(sock, msg) {
  if (!requireGroup(sock, msg)) return;
  const target = mentionedUser(msg);
  if (!target) return reply(sock, msg, `Usage: *${PREFIX()}resetwarn @user*`);
  resetWarns(msg.key.remoteJid, target);
  return sock.sendMessage(msg.key.remoteJid, {
    text: `✅ Warnings cleared for ${mentionTag(target)}.`,
    mentions: [target],
  });
}

// ── welcome / goodbye ────────────────────────────────────────────────────────
async function handleWelcome(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setWelcome(chatId, { enabled: sub === 'on' ? 1 : 0 });
    return reply(sock, msg, `👋 Welcome/goodbye messages are now *${sub.toUpperCase()}* here.`);
  }
  if (sub === 'set') {
    const text = args.slice(1).join(' ').trim();
    if (!text) return reply(sock, msg, `Usage: *${PREFIX()}welcome set <text>* — use {user} and {group} placeholders.`);
    setWelcome(chatId, { join_text: text, enabled: 1 });
    return reply(sock, msg, '👋 Welcome text saved (and enabled).');
  }
  const cfg = getWelcome(chatId);
  return reply(sock, msg,
    `👋 Welcome here: *${cfg?.enabled ? 'ON' : 'OFF'}*\n` +
    `Join: ${cfg?.join_text || '_(default)_'}\nLeave: ${cfg?.leave_text || '_(default)_'}\n\n` +
    `Commands: *${PREFIX()}welcome on/off*, *${PREFIX()}welcome set <text>*, *${PREFIX()}goodbye set <text>*`);
}

async function handleGoodbye(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'set') {
    const text = args.slice(1).join(' ').trim();
    if (!text) return reply(sock, msg, `Usage: *${PREFIX()}goodbye set <text>* — {user}/{group} placeholders work.`);
    setWelcome(msg.key.remoteJid, { leave_text: text, enabled: 1 });
    return reply(sock, msg, '👋 Goodbye text saved (and enabled).');
  }
  return reply(sock, msg, `Usage: *${PREFIX()}goodbye set <text>*`);
}

// ── stats ────────────────────────────────────────────────────────────────────
async function handleStats(sock, msg) {
  if (!requireGroup(sock, msg)) return;
  const chatId = msg.key.remoteJid;
  const top = topStats(chatId, 10);
  if (!top.length) return reply(sock, msg, '📊 No stats yet — I count from when I joined the chat.');
  const total = top.reduce((s, r) => s + r.count, 0);
  const hours = chatHourHistogram(chatId);
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  const medals = ['🥇', '🥈', '🥉'];
  const mentions = top.map(r => `${r.user_id}@s.whatsapp.net`);
  const lines = top.map((r, i) =>
    `${medals[i] || `${i + 1}.`} ${mentionTag(r.user_id)} — ${r.count} msgs (last: ${wat(r.last_ts).format('DD MMM')})`);
  return sock.sendMessage(chatId, {
    text: `📊 *Group stats*\n${lines.join('\n')}\n\n✉️ Counted: ${total}+ messages` +
      (peak ? `\n⏰ Most active hour: ${peak[0]}:00 (${peak[1]} msgs)` : ''),
    mentions,
  }, { quoted: msg });
}

// ── poll ─────────────────────────────────────────────────────────────────────
async function handlePoll(sock, msg, args) {
  if (!requireGroup(sock, msg)) return;
  const parts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    return reply(sock, msg, `Usage: *${PREFIX()}poll <question> | <option 1> | <option 2> [| more…]*`);
  }
  const [name, ...values] = parts;
  if (values.length > 12) return reply(sock, msg, '📊 Max 12 options.');
  await sock.sendMessage(msg.key.remoteJid, {
    poll: { name, values, selectableCount: 1 },
  });
}

export const commands = [
  { name: 'tagall', aliases: ['everyone'], adminOnly: true, execute: handleTagAll },
  { name: 'tag', aliases: ['hidetag'], adminOnly: true, execute: handleTag },
  { name: 'tagnotadmin', aliases: ['tagmembers'], adminOnly: true, execute: handleTagNotAdmin },
  { name: 'warn', adminOnly: true, execute: handleWarn },
  { name: 'warns', adminOnly: true, execute: handleWarns },
  { name: 'resetwarn', adminOnly: true, execute: handleResetWarn },
  { name: 'welcome', adminOnly: true, execute: handleWelcome },
  { name: 'goodbye', adminOnly: true, execute: handleGoodbye },
  { name: 'stats', adminOnly: true, execute: handleStats },
  { name: 'poll', adminOnly: true, execute: handlePoll },
];
