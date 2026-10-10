// Public-access control for groups (admin/owner only).
// .public on/off  → let regular members use the safe command set here
// .block <cmd>    → remove a command from what members can use
// .unblock <cmd>  → restore it
// .blocked        → show current state
import { GLOBAL, getConfig, setConfig, isToggled } from '../db/queries.js';
import { PUBLIC_COMMANDS, publicBlocklist } from '../lib/access.js';
import { reply, PREFIX } from '../lib/helpers.js';

function setBlocklist(chatId, list) {
  setConfig(chatId, 'public_block', [...new Set(list)].join(','));
}

async function handlePublic(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Public mode is a group setting — run it inside the group.');
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'on' || sub === 'off') {
    setConfig(chatId, 'public', sub === 'on' ? '1' : '0');
    if (sub === 'on') {
      const blocked = publicBlocklist(getConfig, chatId);
      const usable = [...PUBLIC_COMMANDS].filter(c => !blocked.includes(c));
      return reply(sock, msg,
        `🌍 *Public mode ON.* Members here can now use ${usable.length} commands:\n` +
        usable.map(c => `\`${PREFIX()}${c}\``).join(' ') +
        `\n\nRemove any with *${PREFIX()}block <cmd>*. Your owner-only commands stay private.`);
    }
    return reply(sock, msg, '🔒 *Public mode OFF.* Only you (and group admins for admin tools) can use the bot here again.');
  }

  const on = isToggled(chatId, 'public', false);
  const blocked = publicBlocklist(getConfig, chatId);
  const usable = [...PUBLIC_COMMANDS].filter(c => !blocked.includes(c));
  return reply(sock, msg,
    `🌍 *Public mode:* ${on ? 'ON' : 'OFF'}\n` +
    (on ? `Members can use: ${usable.map(c => `\`${c}\``).join(' ')}\n` : '') +
    (blocked.length ? `🚫 Blocked: ${blocked.map(c => `\`${c}\``).join(' ')}\n` : '') +
    `\n*${PREFIX()}public on/off* · *${PREFIX()}block <cmd>* · *${PREFIX()}unblock <cmd>*`);
}

async function handleBlock(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Run this inside the group.');
  const cmd = (args[0] || '').toLowerCase().replace(new RegExp(`^\\${PREFIX()}`), '');
  if (!cmd) return reply(sock, msg, `Usage: *${PREFIX()}block <command>* — e.g. \`${PREFIX()}block play\``);
  if (!PUBLIC_COMMANDS.has(cmd)) {
    return reply(sock, msg, `⚠️ *${cmd}* isn't a public command anyway (members can never use it). Public set: ${[...PUBLIC_COMMANDS].map(c => c).join(', ')}`);
  }
  const list = publicBlocklist(getConfig, chatId);
  if (list.includes(cmd)) return reply(sock, msg, `🚫 *${cmd}* is already blocked here.`);
  list.push(cmd);
  setBlocklist(chatId, list);
  return reply(sock, msg, `🚫 Members can no longer use *${PREFIX()}${cmd}* here.`);
}

async function handleUnblock(sock, msg, args) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Run this inside the group.');
  const cmd = (args[0] || '').toLowerCase().replace(new RegExp(`^\\${PREFIX()}`), '');
  if (!cmd) return reply(sock, msg, `Usage: *${PREFIX()}unblock <command>*`);
  const list = publicBlocklist(getConfig, chatId);
  if (!list.includes(cmd)) return reply(sock, msg, `⚠️ *${cmd}* wasn't blocked.`);
  setBlocklist(chatId, list.filter(c => c !== cmd));
  return reply(sock, msg, `✅ Members can use *${PREFIX()}${cmd}* again.`);
}

async function handleBlocked(sock, msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return reply(sock, msg, '⚠️ Run this inside the group — the blocklist is per-group.');
  const blocked = publicBlocklist(getConfig, chatId);
  return reply(sock, msg, blocked.length
    ? `🚫 *Blocked for members here:*\n${blocked.map(c => `• ${c}`).join('\n')}`
    : '✅ Nothing blocked — members can use the full public set (when public mode is on).');
}

export const commands = [
  { name: 'public', adminOnly: true, execute: handlePublic },
  { name: 'block', adminOnly: true, execute: handleBlock },
  { name: 'unblock', adminOnly: true, execute: handleUnblock },
  { name: 'blocked', adminOnly: true, execute: handleBlocked },
];
