// Phase 2 — busy auto-reply, scheduled messages, reminders, export, auto-read
import {
  GLOBAL, getConfig, setConfig, delConfig, isToggled,
  clearBusyReplied, busyAlreadyReplied, markBusyReplied,
  addScheduled, listScheduled, cancelScheduled,
  addReminder, listReminders,
  recentMsgs,
} from '../db/queries.js';
import {
  reply, PREFIX, parseWhen, parseDuration, fmtDT, fmtDuration,
  getText, quotedInfo, jidNum,
} from '../lib/helpers.js';

// ── busy mode ────────────────────────────────────────────────────────────────
async function handleBusy(sock, msg, args) {
  const sub = args.join(' ').trim();
  if (sub.toLowerCase() === 'off') {
    setConfig(GLOBAL, 'busy', '');
    clearBusyReplied();
    return reply(sock, msg, '💤 Busy mode *OFF*. Auto-replies stopped.');
  }
  if (!sub) {
    const cur = getConfig(GLOBAL, 'busy', '');
    return reply(sock, msg, cur
      ? `💤 Busy mode is ON: "${cur}"\nTurn off: *${PREFIX()}busy off*`
      : `💤 Busy mode is OFF.\nSet: *${PREFIX()}busy <reason>*`);
  }
  setConfig(GLOBAL, 'busy', sub);
  clearBusyReplied();
  return reply(sock, msg, `💤 Busy mode *ON*: "${sub}"\nFirst DM from each person gets one auto-reply.`);
}

/** Passive: first DM from each person while busy gets one auto-reply. */
export async function handleBusyIncoming(sock, msg) {
  const reason = getConfig(GLOBAL, 'busy', '');
  if (!reason) return;
  const jid = msg.key.remoteJid;
  if (busyAlreadyReplied(jid)) return;
  markBusyReplied(jid); // mark first so a send failure can't loop
  await sock.sendMessage(jid, {
    text: `💤 *Auto-reply:* I'm busy right now — ${reason}\nI'll get back to you. _(sent by 𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2)_`,
  }, { quoted: msg });
}

// ── scheduled messages ───────────────────────────────────────────────────────
async function handleSchedule(sock, msg, args) {
  const raw = args.join(' ');
  const [whenPart, ...msgParts] = raw.split('|');
  const message = msgParts.join('|').trim();
  const runAt = parseWhen((whenPart || '').trim());
  if (!runAt || !message) {
    return reply(sock, msg,
      `Usage: *${PREFIX()}schedule <when> | <message>* (sends to THIS chat)\n` +
      `When: \`18:30\`, \`tomorrow 09:00\`, \`2026-07-10 18:30\`, \`10/07 18:30\`, \`+2h30m\``);
  }
  if (runAt <= Date.now()) return reply(sock, msg, '⏰ That time is in the past.');
  const id = addScheduled(msg.key.remoteJid, runAt, message);
  return reply(sock, msg, `⏰ Scheduled *#${id}* for ${fmtDT(runAt)} (in ${fmtDuration(runAt - Date.now())}).`);
}

async function handleScheduled(sock, msg) {
  const rows = listScheduled();
  if (!rows.length) return reply(sock, msg, '⏰ Nothing scheduled.');
  const lines = rows.map(r =>
    `*#${r.id}* — ${fmtDT(r.run_at)} → ${r.chat_id.endsWith('@g.us') ? 'group' : '+' + jidNum(r.chat_id)}\n   "${r.message.slice(0, 60)}${r.message.length > 60 ? '…' : ''}"`);
  return reply(sock, msg, `⏰ *Scheduled messages:*\n${lines.join('\n')}\n\nCancel: *${PREFIX()}unschedule <id>*`);
}

async function handleUnschedule(sock, msg, args) {
  const id = parseInt(args[0], 10);
  if (!id) return reply(sock, msg, `Usage: *${PREFIX()}unschedule <id>*`);
  const n = cancelScheduled(id);
  return reply(sock, msg, n ? `✅ Cancelled #${id}.` : `⚠️ No pending schedule #${id}.`);
}

// ── reminders ────────────────────────────────────────────────────────────────
async function handleRemind(sock, msg, args) {
  const ms = parseDuration(args[0]);
  const text = args.slice(1).join(' ').trim();
  if (!ms || !text) return reply(sock, msg, `Usage: *${PREFIX()}remind <duration> <text>* — e.g. \`${PREFIX()}remind 2h call mum\``);
  const runAt = Date.now() + ms;
  addReminder(runAt, text);
  return reply(sock, msg, `⏰ Got it — I'll remind you in ${fmtDuration(ms)} (${fmtDT(runAt)}).`);
}

async function handleRemindMe(sock, msg, args) {
  const ms = parseDuration(args[0]);
  if (!ms) return reply(sock, msg, `Reply to a message with *${PREFIX()}remindme <duration>* — e.g. \`${PREFIX()}remindme 3h\``);
  const q = quotedInfo(msg);
  const quotedText = q ? getText(q.message) : '';
  if (!quotedText) return reply(sock, msg, '⚠️ Reply to a *text* message you want me to bring back.');
  const runAt = Date.now() + ms;
  addReminder(runAt, `You asked me to resend this:\n\n"${quotedText}"`);
  return reply(sock, msg, `⏰ I'll resend that in ${fmtDuration(ms)} (${fmtDT(runAt)}).`);
}

// ── chat export ──────────────────────────────────────────────────────────────
async function handleExport(sock, msg, args) {
  const n = Math.min(parseInt(args[0], 10) || 100, 1000);
  const asJson = (args[1] || '').toLowerCase() === 'json';
  const rows = recentMsgs(msg.key.remoteJid, n);
  if (!rows.length) return reply(sock, msg, '📄 Nothing cached for this chat yet (I keep 7 days of history from when I started running).');

  let buf, fileName, mimetype;
  if (asJson) {
    buf = Buffer.from(JSON.stringify(rows.map(r => ({
      ts: new Date(r.ts).toISOString(), sender: '+' + jidNum(r.sender), name: r.push_name, type: r.type, text: r.content,
    })), null, 2));
    fileName = `chat-export-${Date.now()}.json`;
    mimetype = 'application/json';
  } else {
    buf = Buffer.from(rows.map(r =>
      `[${fmtDT(r.ts)}] ${r.push_name || '+' + jidNum(r.sender)}: ${r.content || `<${r.type}>`}`).join('\n'));
    fileName = `chat-export-${Date.now()}.txt`;
    mimetype = 'text/plain';
  }
  return reply(sock, msg, { document: buf, fileName, mimetype, caption: `📄 Last ${rows.length} cached messages.` });
}

// ── ghost mode (read receipts) ───────────────────────────────────────────────
// ghost ON  = bot sends NO read receipts for messages it handles (default)
// ghost OFF = bot auto-marks handled messages as read (blue ticks go out)
// Per-chat override beats the global default. Note: opening a chat in the real
// WhatsApp app still sends receipts — the bot only governs what IT processes.
async function handleGhost(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'global') {
    const v = (args[1] || '').toLowerCase();
    if (v !== 'on' && v !== 'off') return reply(sock, msg, `Usage: *${PREFIX()}ghost global on/off*`);
    setConfig(GLOBAL, 'ghost', v === 'on' ? '1' : '0');
    return reply(sock, msg, `👻 Ghost mode *${v.toUpperCase()}* everywhere (per-chat overrides still win).`);
  }
  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'ghost', sub === 'on' ? '1' : '0');
    return reply(sock, msg, sub === 'on'
      ? '👻 Ghost *ON* for this chat — no blue ticks from me here.'
      : '👀 Ghost *OFF* for this chat — I\'ll mark messages here as read.');
  }
  if (sub === 'clear') {
    delConfig(chatId, 'ghost');
    return reply(sock, msg, '👻 Per-chat override cleared — this chat follows the global setting.');
  }

  const override = getConfig(chatId, 'ghost', null);
  const globalOn = isToggled(GLOBAL, 'ghost', true);
  const effective = override !== null ? override === '1' : globalOn;
  return reply(sock, msg,
    `👻 *Ghost mode* (read receipts)\n` +
    `Global: *${globalOn ? 'ON' : 'OFF'}* · This chat: *${override === null ? 'follows global' : (override === '1' ? 'ON' : 'OFF')}*\n` +
    `Effective here: *${effective ? 'ON — no blue ticks' : 'OFF — auto-read'}*\n\n` +
    `*${PREFIX()}ghost on/off* (this chat) · *${PREFIX()}ghost global on/off* · *${PREFIX()}ghost clear*\n` +
    `_Note: opening the chat in the WhatsApp app itself still sends receipts._`);
}

// Auto-read is the INVERSE of ghost (ghost ON = no receipts). A plain alias made
// `.autoread on` turn receipts OFF — the opposite of what it says — so give it
// its own thin handler that flips the sub-command and prints auto-read wording.
async function handleAutoread(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'ghost', sub === 'on' ? '0' : '1');
    return reply(sock, msg, sub === 'on'
      ? '👀 Auto-read *ON* for this chat — I\'ll mark messages here as read.'
      : '👻 Auto-read *OFF* for this chat — no blue ticks from me here.');
  }
  return reply(sock, msg, `Usage: *${PREFIX()}autoread on/off* (this chat)`);
}

export const commands = [
  { name: 'busy', execute: handleBusy },
  { name: 'schedule', execute: handleSchedule },
  { name: 'scheduled', execute: handleScheduled },
  { name: 'unschedule', execute: handleUnschedule },
  { name: 'remind', execute: handleRemind },
  { name: 'remindme', execute: handleRemindMe },
  { name: 'export', execute: handleExport },
  { name: 'ghost', execute: handleGhost },
  { name: 'autoread', execute: handleAutoread },
];
