// Features 12-13 — uptime monitors + birthday tracker
import { wat } from '../lib/helpers.js';
import {
  addMonitor, listMonitors, deleteMonitor,
  addBirthday, listBirthdays, deleteBirthdayByName, findBirthday, setBirthdayDayBefore,
} from '../db/queries.js';
import { checkAllMonitors } from '../services/scheduler.js';
import { reply, PREFIX, fmtDT } from '../lib/helpers.js';

// ── uptime monitor ───────────────────────────────────────────────────────────
async function handleMonitor(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    const url = args[1];
    const name = args.slice(2).join(' ').trim() || null;
    if (!url || !/^https?:\/\//i.test(url)) return reply(sock, msg, `Usage: *${PREFIX()}monitor add <url> [name]*`);
    const id = addMonitor(url, name);
    return reply(sock, msg, `🛰️ Monitoring *#${id}* ${name || url} (pinged every 5 min). I'll DM you on up/down changes.`);
  }
  if (sub === 'del') {
    const n = deleteMonitor(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? '✅ Monitor removed.' : `Usage: *${PREFIX()}monitor del <id>*`);
  }
  if (sub === 'check') {
    await reply(sock, msg, '🛰️ Checking all monitors now…');
    const results = await checkAllMonitors(sock, true);
    if (!results.length) return reply(sock, msg, `🛰️ Nothing to check. Add: *${PREFIX()}monitor add <url>*`);
    return reply(sock, msg, results.map(r =>
      `${r.status === 'up' ? '🟢' : '🔴'} *${r.name || r.url}* — ${r.status.toUpperCase()} (${r.detail})`).join('\n'));
  }

  const rows = listMonitors();
  if (!rows.length) return reply(sock, msg, `🛰️ No monitors. Add: *${PREFIX()}monitor add https://mysite.com my site*`);
  const lines = rows.map(m => {
    const icon = m.last_status === 'up' ? '🟢' : m.last_status === 'down' ? '🔴' : '⚪';
    return `${icon} *#${m.id}* ${m.name || m.url}\n   ${m.last_status ? `${m.last_status.toUpperCase()} (${m.last_detail || ''})` : 'not checked yet'}` +
      `${m.last_checked ? ` · checked ${fmtDT(m.last_checked)}` : ''}`;
  });
  return reply(sock, msg, `🛰️ *Monitors:*\n${lines.join('\n')}\n\n*${PREFIX()}monitor check* · *${PREFIX()}monitor del <id>*`);
}

// ── birthdays ────────────────────────────────────────────────────────────────
function parseBdayDate(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/);
  if (!m) return null;
  const day = +m[1], month = +m[2], year = m[3] ? +m[3] : null;
  // Reject impossible dates (e.g. 31-02) — stored, they'd never match a real
  // calendar day and the birthday would silently never fire. Feb 29 allowed
  // (year is optional, so treat it as year-agnostic).
  const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return { day, month, year };
}
function daysUntil(day, month) {
  const now = wat().startOf('day');
  // date(1) first so setting a short month can't overflow into the next one
  let next = now.date(1).month(month - 1).date(day);
  if (next.isBefore(now)) next = next.add(1, 'year');
  return next.diff(now, 'day');
}

async function handleBday(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    const date = parseBdayDate(args[args.length - 1]);
    const name = args.slice(1, -1).join(' ').trim();
    if (!date || !name) return reply(sock, msg, `Usage: *${PREFIX()}bday add <name> <DD-MM[-YYYY]>* — e.g. \`${PREFIX()}bday add Tobi 14-09-2005\``);
    addBirthday(name, date.day, date.month, date.year);
    const d = daysUntil(date.day, date.month);
    return reply(sock, msg, `🎂 Saved *${name}* — ${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}${date.year ? `/${date.year}` : ''} (in ${d} day${d === 1 ? '' : 's'}). Day-before reminder: ON.`);
  }
  if (sub === 'del') {
    const name = args.slice(1).join(' ').trim();
    if (!name) return reply(sock, msg, `Usage: *${PREFIX()}bday del <name>*`);
    const n = deleteBirthdayByName(name);
    return reply(sock, msg, n ? `✅ Removed ${name}.` : `⚠️ No birthday stored for "${name}".`);
  }
  if (sub === 'daybefore') {
    const name = args.slice(1, -1).join(' ').trim();
    const on = (args[args.length - 1] || '').toLowerCase() === 'on';
    const b = name ? findBirthday(name) : null;
    if (!b) return reply(sock, msg, `Usage: *${PREFIX()}bday daybefore <name> on/off*`);
    setBirthdayDayBefore(b.id, on);
    return reply(sock, msg, `🎂 Day-before reminder for *${b.name}*: ${on ? 'ON' : 'OFF'}.`);
  }
  if (sub && sub !== 'list') {
    // !bday <name> → days until
    const b = findBirthday(args.join(' '));
    if (!b) return reply(sock, msg, `⚠️ No birthday stored for "${args.join(' ')}".`);
    const d = daysUntil(b.day, b.month);
    const nextYear = wat().add(d, 'day').year();
    const age = b.year ? ` (turning ${nextYear - b.year})` : '';
    return reply(sock, msg, d === 0
      ? `🎉 *${b.name}'s birthday is TODAY!*${age}`
      : `🎂 *${b.name}* — ${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')} — in *${d} day${d === 1 ? '' : 's'}*${age}`);
  }

  const rows = listBirthdays();
  if (!rows.length) return reply(sock, msg, `🎂 No birthdays saved. Add: *${PREFIX()}bday add <name> <DD-MM[-YYYY]>*`);
  const sorted = rows
    .map(b => ({ ...b, until: daysUntil(b.day, b.month) }))
    .sort((a, b) => a.until - b.until);
  const lines = sorted.map(b =>
    `${b.until === 0 ? '🎉' : '🎂'} *${b.name}* — ${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')}` +
    `${b.year ? `/${b.year}` : ''} · ${b.until === 0 ? '*TODAY!*' : `in ${b.until}d`}`);
  return reply(sock, msg, `🎂 *Birthdays (soonest first):*\n${lines.join('\n')}`);
}

export const commands = [
  { name: 'monitor', aliases: ['monitors'], execute: handleMonitor },
  { name: 'bday', aliases: ['birthday', 'bdays'], execute: handleBday },
];
