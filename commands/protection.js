// Phase 1 command surface: antidelete / viewonce / antiword / antilink / alert
import {
  GLOBAL, getConfig, setConfig, delConfig, isToggled,
  addAntiword, removeAntiword, listAntiwords,
  addWhitelist, removeWhitelist, listWhitelist,
  addAlert, removeAlert, listAlerts,
} from '../db/queries.js';
import { reply, PREFIX, jidNum } from '../lib/helpers.js';

function onOff(v) { return v ? 'ON ✅' : 'OFF ❌'; }

async function handleAntidelete(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();

  // Global mode: route deleted messages from EVERY chat to one chosen number.
  //   .antidelete all <number>  → enable + set destination
  //   .antidelete all off       → disable global mode
  //   .antidelete all           → status
  if (sub === 'all') {
    const second = (args[1] || '').toLowerCase();
    if (second === 'off') {
      setConfig(GLOBAL, 'antidelete_all', '0');
      return reply(sock, msg, '🌐 Global anti-delete *OFF*. Deleted messages follow per-chat settings again.');
    }
    const raw = (args[1] || '').trim();
    const num = raw.replace(/\D/g, '');
    if (!raw) {
      const on = isToggled(GLOBAL, 'antidelete_all', false);
      const to = getConfig(GLOBAL, 'antidelete_to', '');
      return reply(sock, msg,
        `🌐 *Global anti-delete:* ${onOff(on)}${on && to ? `\n📩 Sending all deletes to: +${jidNum(to)}` : ''}\n\n` +
        `Set it: *${PREFIX()}antidelete all <number>* (e.g. \`${PREFIX()}antidelete all 2348012345678\`)\n` +
        `Turn off: *${PREFIX()}antidelete all off*`);
    }
    if (num.length < 7 || num.length > 15) {
      return reply(sock, msg,
        `⚠️ Give a full phone number in international format (7–15 digits), e.g. \`${PREFIX()}antidelete all 2348012345678\`. ` +
        `A short/blank number would silently send deletes nowhere.`);
    }
    setConfig(GLOBAL, 'antidelete_to', `${num}@s.whatsapp.net`);
    setConfig(GLOBAL, 'antidelete_all', '1');
    return reply(sock, msg,
      `🌐 Global anti-delete *ON*. Every deleted message (all chats) now goes to *+${num}*.\n` +
      `_This overrides the per-chat setting. Turn off with ${PREFIX()}antidelete all off._`);
  }

  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'antidelete', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `🗑️ Anti-delete is now *${onOff(sub === 'on')}* for this chat.`);
  }

  const globalOn = isToggled(GLOBAL, 'antidelete_all', false);
  return reply(sock, msg,
    `🗑️ Anti-delete here: *${onOff(isToggled(chatId, 'antidelete', false))}* (goes to your own DM)\n` +
    `🌐 Global mode: *${onOff(globalOn)}*${globalOn ? ` → +${jidNum(getConfig(GLOBAL, 'antidelete_to', ''))}` : ''}\n\n` +
    `*${PREFIX()}antidelete on/off* (this chat) · *${PREFIX()}antidelete all <number>* (all chats → one DM)`);
}

async function handleViewonce(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'viewonce', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `👁️ View-once auto-save is now *${onOff(sub === 'on')}* for this chat.`);
  }
  return reply(sock, msg, `👁️ View-once auto-save here: *${onOff(isToggled(chatId, 'viewonce', false))}*\nUse *${PREFIX()}viewonce on/off*.`);
}

async function handleEdittrack(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'edittrack', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `✏️ Edit tracking is now *${onOff(sub === 'on')}* for this chat.`);
  }
  return reply(sock, msg, `✏️ Edit tracking here: *${onOff(isToggled(chatId, 'edittrack', false))}*\nUse *${PREFIX()}edittrack on/off* (default: off). Edits get DM'd to you with before/after.`);
}

async function handleAntiword(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Antiword works in groups.');
  const sub = (args[0] || '').toLowerCase();
  const rest = args.slice(1).join(' ').trim().toLowerCase();

  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'antiword', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `🤬 Antiword is now *${onOff(sub === 'on')}* here.`);
  }
  if (sub === 'add' && rest) {
    addAntiword(chatId, rest);
    setConfig(chatId, 'antiword', '1');
    return reply(sock, msg, `🤬 Added "*${rest}*" to the banned list (antiword ON).`);
  }
  if (sub === 'remove' && rest) {
    const n = removeAntiword(chatId, rest);
    return reply(sock, msg, n ? `✅ Removed "*${rest}*".` : `⚠️ "*${rest}*" wasn't on the list.`);
  }
  if (sub === 'list') {
    const words = listAntiwords(chatId);
    return reply(sock, msg, words.length
      ? `🤬 *Banned words (${onOff(isToggled(chatId, 'antiword', false))}):*\n${words.map(w => `• ${w}`).join('\n')}`
      : '🤬 No banned words set here.');
  }
  return reply(sock, msg, `Usage: *${PREFIX()}antiword add/remove <word>*, *list*, *on/off*`);
}

async function handleAntilink(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Antilink works in groups.');
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'antilink', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `🔗 Antilink is now *${onOff(sub === 'on')}* here. (I need group-admin to delete/kick.)`);
  }
  if (sub === 'whitelist') {
    const action = (args[1] || '').toLowerCase();
    const pattern = args.slice(2).join(' ').trim().toLowerCase();
    if (action === 'add' && pattern) {
      addWhitelist(chatId, pattern);
      return reply(sock, msg, `✅ Links containing "*${pattern}*" are whitelisted.`);
    }
    if (action === 'remove' && pattern) {
      const n = removeWhitelist(chatId, pattern);
      return reply(sock, msg, n ? `✅ Removed "*${pattern}*" from whitelist.` : `⚠️ Not on the whitelist.`);
    }
    const list = listWhitelist(chatId);
    return reply(sock, msg, list.length
      ? `🔗 *Whitelist:*\n${list.map(p => `• ${p}`).join('\n')}`
      : '🔗 Whitelist is empty. Add: *antilink whitelist add youtube.com*');
  }
  return reply(sock, msg,
    `🔗 Antilink here: *${onOff(isToggled(chatId, 'antilink', false))}*\n` +
    `Usage: *${PREFIX()}antilink on/off*, *whitelist add/remove <pattern>*, *whitelist*`);
}

async function handleAlert(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  const sub = (args[0] || '').toLowerCase();
  const rest = args.slice(1).join(' ').trim().toLowerCase();
  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'alerts', sub === 'on' ? '1' : '0');
    return reply(sock, msg, `🔔 Keyword alerts are now *${onOff(sub === 'on')}* for this chat.`);
  }
  if (sub === 'add' && rest) {
    addAlert(rest);
    setConfig(chatId, 'alerts', '1'); // adding here implies you want them here
    return reply(sock, msg, `🔔 I'll DM you whenever "*${rest}*" appears in chats where alerts are ON (now on here). Enable elsewhere with *${PREFIX()}alert on*.`);
  }
  if (sub === 'remove' && rest) {
    const n = removeAlert(rest);
    return reply(sock, msg, n ? `✅ Alert "*${rest}*" removed.` : `⚠️ No such alert.`);
  }
  const list = listAlerts();
  return reply(sock, msg, list.length
    ? `🔔 *Keyword alerts* (this chat: ${onOff(isToggled(chatId, 'alerts', false))}):\n${list.map(k => `• ${k}`).join('\n')}\n\n*${PREFIX()}alert add <word>* · *${PREFIX()}alert on/off* per chat`
    : `🔔 No alerts yet. Add: *${PREFIX()}alert add <your name>*`);
}

// HARDEN #7 — kill switch: disables ALL passive handlers globally, persists in DB.
async function handlePanic(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'off') {
    setConfig(GLOBAL, 'panic', '0');
    return reply(sock, msg, '🟢 *Panic mode OFF.* Passive handlers resume per their chat toggles (anti-delete, view-once, edit tracker, antiword, antilink, alerts, welcome, busy auto-reply, stats).');
  }
  setConfig(GLOBAL, 'panic', '1');
  return reply(sock, msg,
    '🔴 *PANIC MODE ON* — all passive handlers are now disabled everywhere:\n' +
    '• anti-delete & view-once capture\n• edit tracker\n• antiword & antilink\n• keyword alerts\n• welcome/goodbye\n• busy auto-reply & stats logging\n\n' +
    `Commands still work. Restore with *${PREFIX()}panic off*. This survives restarts.`);
}

export const commands = [
  { name: 'antidelete', execute: handleAntidelete },
  { name: 'viewonce', execute: handleViewonce },
  { name: 'edittrack', execute: handleEdittrack },
  { name: 'antiword', execute: handleAntiword },
  { name: 'antilink', execute: handleAntilink },
  { name: 'alert', aliases: ['alerts'], execute: handleAlert },
  { name: 'panic', aliases: ['silent'], execute: handlePanic },
];
