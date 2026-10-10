// Phase 5 — IoT / PC remote / Nexus relay / bot health
import os from 'os';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { espPublish, espRequest } from '../services/mqtt-bridge.js';
import { makeBackup } from '../services/scheduler.js';
import { requestRestart } from '../lib/control.js';
import { GLOBAL, setConfig } from '../db/queries.js';
import { reply, PREFIX, fmtDuration, ownerJid } from '../lib/helpers.js';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';

// MQTT/ESP errors from the bridge are prefixed with 📡 and are user-helpful
// (e.g. "MQTT_URL not set"). Pass those through; log + genericize anything else
// so broker internals / stack text don't leak into chat.
function espErr(sock, msg, err) {
  const m = err?.message || '';
  if (m.startsWith('📡')) return reply(sock, msg, m);
  console.error('[RF] IoT command failed:', err);
  return reply(sock, msg, '📡 ESP32/MQTT request failed — the broker or device may be offline.');
}

// ── ESP32 via MQTT ───────────────────────────────────────────────────────────
async function handleLed(sock, msg, args) {
  const state = (args[0] || '').toLowerCase();
  if (state !== 'on' && state !== 'off') return reply(sock, msg, `Usage: *${PREFIX()}led on/off*`);
  try {
    const topic = await espPublish('led', state);
    return reply(sock, msg, `💡 Sent *${state.toUpperCase()}* → \`${topic}\``);
  } catch (err) { return espErr(sock, msg, err); }
}

async function handleRoom(sock, msg) {
  try {
    const res = await espRequest('room/status', 'get');
    return reply(sock, msg, `🏠 *Room status:*\n${res}`);
  } catch (err) { return espErr(sock, msg, err); }
}

async function handleEsp(sock, msg, args) {
  const topic = args[0];
  const payload = args.slice(1).join(' ');
  if (!topic || !payload) return reply(sock, msg, `Usage: *${PREFIX()}esp <topic> <payload>*`);
  try {
    const full = await espPublish(topic, payload);
    return reply(sock, msg, `📡 Published to \`${full}\`: ${payload}`);
  } catch (err) { return espErr(sock, msg, err); }
}

// ── PC remote (owner-only; shutdown needs confirm) ───────────────────────────
let pendingShutdown = 0;

async function handlePc(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'lock') {
    if (!isWin) return reply(sock, msg, '🖥️ Lock is only wired up for Windows.');
    await execAsync('rundll32.exe user32.dll,LockWorkStation');
    return reply(sock, msg, '🔒 PC locked.');
  }

  if (sub === 'shutdown') {
    pendingShutdown = Date.now();
    return reply(sock, msg, `⚠️ Really shut down the PC? Send *${PREFIX()}pc confirm* within 30s.`);
  }
  if (sub === 'confirm') {
    if (Date.now() - pendingShutdown > 30_000) return reply(sock, msg, '⌛ No shutdown pending (or it expired).');
    pendingShutdown = 0;
    await reply(sock, msg, '🛑 Shutting down in 30 seconds… (`shutdown /a` on the PC to abort)');
    await execAsync(isWin ? 'shutdown /s /t 30' : 'shutdown -h +1');
    return;
  }

  if (sub === 'screenshot' || sub === 'ss') {
    if (!isWin) return reply(sock, msg, '🖥️ Screenshot is only wired up for Windows.');
    const file = path.join(os.tmpdir(), `rf-ss-${Date.now()}.png`);
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
      `$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
      `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ` +
      `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); ` +
      `$bmp.Save('${file.replace(/\\/g, '\\\\')}'); $g.Dispose(); $bmp.Dispose()`;
    try {
      await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 20000 });
      const buf = fs.readFileSync(file);
      await reply(sock, msg, { image: buf, caption: '🖥️ Screenshot' });
    } finally {
      // Always clean up the temp PNG — on a PowerShell/read failure the old code
      // left it behind, accumulating screenshots in temp.
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    return;
  }

  if (sub === 'status') return handleStatus(sock, msg);
  return reply(sock, msg, `Usage: *${PREFIX()}pc lock | shutdown | screenshot | status*`);
}

// ── Nexus relay (external NEXUS_API_URL system) ───────────────────────────────
// NOTE: this is the HTTP relay to an external "Nexus" box. The conversational
// AI assistant is a separate command (.nexus, see commands/nexus.js); this one
// is now `.relay` to avoid the clash.
async function handleRelay(sock, msg, args) {
  const command = args.join(' ').trim();
  const base = process.env.NEXUS_API_URL;
  if (!base) return reply(sock, msg, '🧠 NEXUS_API_URL is not set in config.env.');
  if (!command) return reply(sock, msg, `Usage: *${PREFIX()}relay <command>*`);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, source: 'redflag-v2' }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return reply(sock, msg, `🧠 *Nexus:*\n${text.slice(0, 3000) || '(empty response)'}`);
  } catch {
    return reply(sock, msg, '🧠 Nexus is offline or unreachable right now.');
  }
}

// ── bot health ───────────────────────────────────────────────────────────────
async function diskInfo() {
  try {
    if (isWin) {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "$d=Get-PSDrive C; \\"$($d.Used) $($d.Free)\\""', { timeout: 10000 });
      const [used, free] = stdout.trim().split(/\s+/).map(Number);
      return { used, total: used + free };
    }
    const { stdout } = await execAsync("df -k . | tail -1 | awk '{print $3, $2}'");
    const [usedK, totalK] = stdout.trim().split(/\s+/).map(Number);
    return { used: usedK * 1024, total: totalK * 1024 };
  } catch { return null; }
}
const gb = b => (b / 1024 ** 3).toFixed(1) + ' GB';

async function handleStatus(sock, msg) {
  const mem = process.memoryUsage();
  const lines = [
    '🚩 *𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 — status*',
    `⏱️ Uptime: ${fmtDuration(process.uptime() * 1000)}`,
    `🧠 RAM (bot): ${(mem.rss / 1024 / 1024).toFixed(0)} MB`,
    `🧠 RAM (system): ${gb(os.totalmem() - os.freemem())} / ${gb(os.totalmem())}`,
    `⚙️ Node ${process.version} on ${process.platform}`,
  ];
  const disk = await diskInfo();
  if (disk) {
    const pct = Math.round((disk.used / disk.total) * 100);
    lines.push(`💾 Disk: ${gb(disk.used)} / ${gb(disk.total)} (${pct}%)${pct > 85 ? ' ⚠️ *OVER 85% FULL!*' : ''}`);
  }
  return reply(sock, msg, lines.join('\n'));
}

// ── ping ─────────────────────────────────────────────────────────────────────
async function handlePing(sock, msg) {
  const raw = msg.messageTimestamp;
  const secs = typeof raw === 'object' && raw !== null ? Number(raw.toNumber?.() ?? raw.low ?? 0) : Number(raw);
  const sent = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
  const latency = sent ? Math.max(0, Date.now() - sent) : null;
  return reply(sock, msg,
    `🏓 *Pong!*${latency !== null ? ` ⚡ ${latency}ms` : ''}\n⏱️ Uptime: ${fmtDuration(process.uptime() * 1000)}`);
}

// ── DB backup (HARDEN #9) ────────────────────────────────────────────────────
async function handleBackup(sock, msg) {
  await reply(sock, msg, '💾 Backing up the database…');
  try {
    const dest = await makeBackup();
    const fileName = path.basename(dest);
    await sock.sendMessage(ownerJid(sock), {
      document: fs.readFileSync(dest),
      fileName,
      mimetype: 'application/octet-stream',
      caption: `💾 ${fileName} — keep this safe. (Auto-backup runs nightly at 02:00; last 7 kept.)`,
    });
  } catch (err) {
    console.error('[RF] backup failed:', err.message);
    await reply(sock, msg, '💾 Backup failed — check the console.');
  }
}

// ── prefix (DB-backed, survives restarts) ────────────────────────────────────
async function handlePrefix(sock, msg, args) {
  const next = (args[0] || '').trim();
  if (!next) {
    return reply(sock, msg, `⌨️ Current prefix: *${PREFIX()}*\nChange: *${PREFIX()}prefix <new>* — e.g. \`${PREFIX()}prefix !\``);
  }
  if (next.length > 3 || /[a-z0-9\s]/i.test(next)) {
    return reply(sock, msg, '⌨️ Prefix must be 1–3 symbols, no letters/numbers/spaces (e.g. `.` `!` `#` `>>`).');
  }
  setConfig(GLOBAL, 'prefix', next);
  return reply(sock, msg, `⌨️ Prefix changed to *${next}* — commands are now \`${next}menu\`, \`${next}ping\`, etc.`);
}

// ── session rescue ───────────────────────────────────────────────────────────
// .reset  → bounce the socket (keeps the session). Fixes "waiting for this
//           message" decay in DMs without touching pairing.
// .relink → wipe the session and re-pair fresh (new code in the PANEL console).
async function handleReset(sock, msg) {
  await reply(sock, msg, '🔄 Restarting the connection… back in ~10s. If DMs were stuck on "waiting", send me a message after I reconnect.');
  setTimeout(() => requestRestart(false).catch(e => console.error('[RF] reset failed:', e.message)), 1500);
}

async function handleRelink(sock, msg, args) {
  if ((args[0] || '').toLowerCase() !== 'confirm') {
    return reply(sock, msg,
      `⚠️ *${PREFIX()}relink* wipes the WhatsApp session and re-pairs from scratch.\n` +
      `A new pairing code will appear in the *server console* — you must be able to see it.\n\n` +
      `Sure? Send *${PREFIX()}relink confirm*`);
  }
  await reply(sock, msg, '🔗 Wiping session — watch the server console for the new pairing code.');
  setTimeout(() => requestRestart(true).catch(e => console.error('[RF] relink failed:', e.message)), 1500);
}

export const commands = [
  { name: 'prefix', execute: handlePrefix },
  { name: 'reset', aliases: ['restart'], execute: handleReset },
  { name: 'relink', execute: handleRelink },
  { name: 'led', execute: handleLed },
  { name: 'room', execute: handleRoom },
  { name: 'esp', execute: handleEsp },
  { name: 'pc', execute: handlePc },
  { name: 'relay', execute: handleRelay },
  { name: 'status', aliases: ['health'], execute: handleStatus },
  { name: 'ping', execute: handlePing },
  { name: 'backup', execute: handleBackup },
];
