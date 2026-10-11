import { PREFIX, isOwnerMsg, isGroupAdmin, senderJid, jidNum, getText, reply } from './helpers.js';
import { GLOBAL, getConfig, isToggled } from '../db/queries.js';
import { PUBLIC_COMMANDS, publicBlocklist } from './access.js';

// passive handlers
import { handleRevoke, cacheIncoming, captureViewOnce } from '../handlers/anti-delete.js';
import { handleEdit } from '../handlers/edit-tracker.js';
import { checkAntilink } from '../handlers/antilink.js';
import { checkAntiword } from '../handlers/antiword.js';
import { checkKeywordAlerts } from '../handlers/keyword-alert.js';
import { handleBusyIncoming } from '../commands/chat-tools.js';
import { logGroupStat } from '../commands/group-admin.js';

// command modules — each exports `commands: [{name, aliases, adminOnly, execute}]`
import { commands as menuCmds } from '../commands/menu.js';
import { commands as chatCmds } from '../commands/chat-tools.js';
import { commands as aiCmds } from '../commands/ai.js';
import { commands as uniCmds } from '../commands/uni.js';
import { commands as iotCmds } from '../commands/iot.js';
import { commands as dailyCmds } from '../commands/daily.js';
import { commands as utilCmds } from '../commands/utility.js';
import { commands as stickerCmds } from '../commands/stickers.js';
import { commands as dlCmds } from '../commands/downloaders.js';
import { commands as adminCmds } from '../commands/group-admin.js';
import { commands as protectCmds } from '../commands/protection.js';
import { commands as pinCmds } from '../commands/pins.js';
import { commands as prodCmds } from '../commands/productivity.js';
import { commands as stashCmds } from '../commands/stash.js';
import { commands as trackerCmds } from '../commands/trackers.js';
import { commands as mediaFunCmds } from '../commands/media-fun.js';
import { commands as vvCmds } from '../commands/vv.js';
import { commands as accessCmds } from '../commands/access.js';
import { commands as nexusCmds } from '../commands/nexus.js';
import { commands as newsCmds } from '../commands/news.js';

const registry = new Map();
for (const mod of [menuCmds, chatCmds, aiCmds, uniCmds, iotCmds, dailyCmds, utilCmds, stickerCmds, dlCmds, adminCmds, protectCmds,
  pinCmds, prodCmds, stashCmds, trackerCmds, mediaFunCmds, vvCmds, accessCmds, nexusCmds, newsCmds]) {
  for (const cmd of mod) {
    registry.set(cmd.name, cmd);
    for (const a of cmd.aliases || []) registry.set(a, cmd);
  }
}
console.log(`[RF] Registered ${new Set(registry.values()).size} commands`);

export function getRegistry() { return registry; }

// Light per-user cooldown for public (non-owner) command use — spam guard.
const PUBLIC_COOLDOWN_MS = 5000;
const publicLastUse = new Map();
function onPublicCooldown(userNum) {
  const now = Date.now();
  if (now - (publicLastUse.get(userNum) || 0) < PUBLIC_COOLDOWN_MS) return true;
  publicLastUse.set(userNum, now);
  return false;
}

export async function handleUpsert(sock, msg) {
  const chatId = msg.key.remoteJid;
  if (chatId === 'status@broadcast') return;
  const isGroup = chatId.endsWith('@g.us');

  // kill switch (HARDEN #7): one cached lookup disables every passive handler
  const panic = isToggled(GLOBAL, 'panic', false);

  // 1) protocol events: delete-for-everyone (REVOKE) and edits (MESSAGE_EDIT)
  const proto = msg.message?.protocolMessage;
  if (proto) {
    if (panic) return;
    if (proto.type === 0 || proto.type === 'REVOKE') {
      try { await handleRevoke(sock, msg, proto); } catch (e) { console.error('[RF] anti-delete:', e); }
    } else if (proto.type === 14 || proto.type === 'MESSAGE_EDIT') {
      try { await handleEdit(sock, msg, proto); } catch (e) { console.error('[RF] edit-tracker:', e); }
    }
    return; // protocol messages carry no user content
  }

  // 2) passive pipeline — each step isolated, none may block the next.
  // Toggle checks hit the in-memory config cache, never the DB (HARDEN #3).
  if (!panic) {
    try { cacheIncoming(sock, msg); } catch (e) { console.error('[RF] cache:', e); }
    try { captureViewOnce(sock, msg); } catch (e) { console.error('[RF] viewonce:', e); }
  }

  // ghost mode: per-chat override beats global default (default ghost ON = no receipts)
  const ghostOverride = getConfig(chatId, 'ghost', null);
  const ghost = ghostOverride !== null ? ghostOverride === '1' : isToggled(GLOBAL, 'ghost', true);
  if (!ghost) {
    try { await sock.readMessages([msg.key]); } catch { /* ignore */ }
  }

  const body = getText(msg.message);

  // TEMP DEBUG (silence with RF_DEBUG=0): logs the owner's own messages + any
  // command (prefix) the handler sees — not every group chat line.
  if (process.env.RF_DEBUG !== '0' && (msg.key?.fromMe || (body && body.startsWith(PREFIX())))) {
    console.log(`[RF][dbg] rx chat=${chatId} fromMe=${!!msg.key?.fromMe} grp=${isGroup} prefix=${PREFIX()} body=${JSON.stringify((body || '').slice(0, 60))}`);
  }

  if (!panic && isGroup && !msg.key.fromMe) {
    try { logGroupStat(sock, msg); } catch (e) { console.error('[RF] stats:', e); }
    if (body) {
      try { if (await checkAntiword(sock, msg, body)) return; } catch (e) { console.error('[RF] antiword:', e); }
      try { if (await checkAntilink(sock, msg, body)) return; } catch (e) { console.error('[RF] antilink:', e); }
      try { checkKeywordAlerts(sock, msg, body); } catch (e) { console.error('[RF] alerts:', e); }
    }
  }

  if (!panic && !isGroup && !msg.key.fromMe) {
    try { await handleBusyIncoming(sock, msg); } catch (e) { console.error('[RF] busy:', e); }
  }

  // 3) command dispatch
  const prefix = PREFIX();

  // Natural NEXUS address: the owner can just start a message with the wake word
  // ("nexus …") — no prefix — so talking to it feels like talking to a person.
  if (body && !body.startsWith(prefix) && isOwnerMsg(msg, sock)) {
    const wake = (process.env.NEXUS_WAKE || 'nexus').toLowerCase();
    const first = body.trim().split(/\s+/)[0].toLowerCase().replace(/[,:]$/, '');
    if (first === wake) {
      const nx = registry.get('nexus');
      if (nx) {
        const rest = body.trim().slice(body.trim().split(/\s+/)[0].length).trim();
        const nxArgs = rest ? rest.split(/\s+/) : [];
        try { await sock.sendMessage(chatId, { react: { text: '🧠', key: msg.key } }); } catch { /* ignore */ }
        try {
          await nx.execute(sock, msg, nxArgs);
        } catch (err) {
          console.error('[RF] nexus (natural address) failed:', err);
          await reply(sock, msg, '🧠 NEXUS hit a snag — try again.');
        }
        return;
      }
    }
  }

  if (!body || !body.startsWith(prefix)) return;
  const args = body.slice(prefix.length).trim().split(/\s+/);
  const name = (args.shift() || '').toLowerCase();
  const cmd = registry.get(name);
  if (process.env.RF_DEBUG !== '0') console.log(`[RF][dbg] prefix-hit name=${name} found=${!!cmd} owner=${isOwnerMsg(msg, sock)}`);
  if (!cmd) return;

  // gates: owner by default; group-admin commands allow group admins too;
  // in a group with public mode ON, members may run the safe public set.
  const owner = isOwnerMsg(msg, sock);
  if (cmd.adminOnly) {
    if (!isGroup) { if (!owner) return; }
    else if (!owner && !(await isGroupAdmin(sock, chatId, senderJid(msg, sock)))) return;
  } else if (!owner) {
    if (!isGroup) return;                                   // DMs stay owner-only
    if (!isToggled(chatId, 'public', false)) return;        // group opted in?
    if (!PUBLIC_COMMANDS.has(cmd.name)) return;             // command is public-safe?
    if (publicBlocklist(getConfig, chatId).includes(cmd.name)) return; // not blocked here?
    if (onPublicCooldown(jidNum(senderJid(msg, sock)))) return;        // light anti-spam
  }

  try {
    await sock.sendMessage(chatId, { react: { text: '🚩', key: msg.key } });
  } catch { /* ignore react failures */ }

  try {
    await cmd.execute(sock, msg, args);
  } catch (err) {
    console.error(`[RF] command ${name} failed:`, err);
    await reply(sock, msg, `❌ Something went wrong running *${name}*. Check the console for details.`);
  }

  setTimeout(async () => {
    try { await sock.sendMessage(chatId, { react: { text: '', key: msg.key } }); } catch { /* ignore */ }
  }, 1500);
}
