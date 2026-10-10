// Features 4-7 — to-do list, pomodoro, recurring reminders, quick capture
import { wat } from '../lib/helpers.js';
import {
  addTodo, listTodos, markTodoDone, deleteTodo, clearDoneTodos,
  getPomo, startPomo, stopPomo,
  addRecurring, listRecurring, cancelRecurring,
  addIdea, listIdeas, deleteIdea, searchIdeas,
} from '../db/queries.js';
import {
  reply, PREFIX, parseDuration, parseClockTime, fmtDuration, fmtDT, paginate,
} from '../lib/helpers.js';

// ── to-do list ───────────────────────────────────────────────────────────────
async function handleTodo(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    let rest = args.slice(1);
    let priority = 0;
    if ((rest[0] || '').toLowerCase() === '!high') { priority = 1; rest = rest.slice(1); }
    const task = rest.join(' ').trim();
    if (!task) return reply(sock, msg, `Usage: *${PREFIX()}todo add [!high] <task>*`);
    const id = addTodo(task, priority);
    return reply(sock, msg, `☑️ Added *#${id}*${priority ? ' 🔥' : ''}: ${task}`);
  }
  if (sub === 'done') {
    const n = markTodoDone(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? `✅ Done. Good work.` : `⚠️ No open task with that id.`);
  }
  if (sub === 'del') {
    const n = deleteTodo(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? `🗑️ Deleted.` : `⚠️ No task with that id.`);
  }
  if (sub === 'clear') {
    const n = clearDoneTodos();
    return reply(sock, msg, `🧹 Cleared ${n} completed task${n === 1 ? '' : 's'}.`);
  }

  const rows = listTodos();
  if (!rows.length) return reply(sock, msg, `☑️ To-do list is empty. Add: *${PREFIX()}todo add [!high] <task>*`);
  const lines = rows.map(t => `${t.priority ? '🔥' : '▫️'} *#${t.id}* ${t.task}`);
  return reply(sock, msg, `☑️ *To-do (${rows.length} open):*\n${lines.join('\n')}\n\n*${PREFIX()}todo done/del <id>* · *${PREFIX()}todo clear*`);
}

// ── pomodoro (single active session — DECISIONS.md) ──────────────────────────
async function handlePomo(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'stop') {
    const n = stopPomo();
    return reply(sock, msg, n ? '⏹️ Pomodoro cancelled.' : '⏹️ No pomodoro running.');
  }
  if (sub === 'status') {
    const p = getPomo();
    if (!p?.active) return reply(sock, msg, `🍅 No pomodoro running. Start: *${PREFIX()}pomo* or *${PREFIX()}pomo 50 10 4*`);
    const left = p.phase_ends_at - Date.now();
    return reply(sock, msg,
      `🍅 *Pomodoro* — cycle ${p.cycle}/${p.cycles}\n` +
      `${p.phase === 'work' ? '🔨 Working' : '⏸️ On break'} — *${fmtDuration(left)}* left in this phase.`);
  }

  const existing = getPomo();
  if (existing?.active) {
    return reply(sock, msg, `🍅 A pomodoro is already running (*${PREFIX()}pomo status*). Stop it first: *${PREFIX()}pomo stop*`);
  }
  const work = parseInt(args[0], 10) || 25;
  const brk = parseInt(args[1], 10) || 5;
  const cycles = parseInt(args[2], 10) || 4;
  if (work < 1 || work > 180 || brk < 1 || brk > 60 || cycles < 1 || cycles > 12) {
    return reply(sock, msg, `Usage: *${PREFIX()}pomo [work] [break] [cycles]* — e.g. \`${PREFIX()}pomo 50 10 4\` (limits: 180/60/12)`);
  }
  startPomo(work, brk, cycles);
  return reply(sock, msg, `🍅 *Pomodoro started:* ${work}m work / ${brk}m break × ${cycles} cycles.\n🔨 Cycle 1 — focus! I'll ping you in ${work}m.`);
}

// ── recurring reminders ──────────────────────────────────────────────────────
const DOW = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

export function nextOccurrence(schedule, from = Date.now()) {
  if (schedule.type === 'interval') return from + schedule.ms;
  const base = wat(from);
  if (schedule.type === 'daily') {
    let d = base.hour(schedule.hh).minute(schedule.mm).second(0).millisecond(0);
    if (d.valueOf() <= from) d = d.add(1, 'day');
    return d.valueOf();
  }
  if (schedule.type === 'weekly') {
    // dayjs: 0=Sun..6=Sat; ours: 1=Mon..7=Sun
    const targetDow = schedule.dow === 7 ? 0 : schedule.dow;
    let d = base.hour(schedule.hh).minute(schedule.mm).second(0).millisecond(0);
    while (d.day() !== targetDow || d.valueOf() <= from) d = d.add(1, 'day');
    return d.valueOf();
  }
  return null;
}

function parseEverySchedule(args) {
  // "1h" | "30m" → interval
  const ms = parseDuration(args[0]);
  if (ms && ms >= 5 * 60000 && /^(\d+[dhms])+$/i.test(args[0])) {
    return { schedule: { type: 'interval', ms }, label: `every ${args[0]}`, textStart: 1 };
  }
  // "day 9pm" | "day 21:00"
  if ((args[0] || '').toLowerCase() === 'day') {
    const t = parseClockTime(args[1]);
    if (t) return { schedule: { type: 'daily', ...t }, label: `daily at ${args[1]}`, textStart: 2 };
  }
  // "monday 8am"
  const dow = DOW[(args[0] || '').toLowerCase()];
  if (dow) {
    const t = parseClockTime(args[1]);
    if (t) return { schedule: { type: 'weekly', dow, ...t }, label: `${args[0].toLowerCase()}s at ${args[1]}`, textStart: 2 };
  }
  return null;
}

async function handleEvery(sock, msg, args) {
  if ((args[0] || '').toLowerCase() === 'stop') {
    const id = parseInt(args[1], 10);
    if (!id) return reply(sock, msg, `Usage: *${PREFIX()}every stop <id>* (see *${PREFIX()}recurring*)`);
    const n = cancelRecurring(id);
    return reply(sock, msg, n ? '✅ Recurring reminder cancelled.' : `⚠️ No active recurring reminder #${id}.`);
  }
  const parsed = parseEverySchedule(args);
  const text = parsed ? args.slice(parsed.textStart).join(' ').trim() : '';
  if (!parsed || !text) {
    return reply(sock, msg,
      `Usage:\n• *${PREFIX()}every 1h drink water* (min 5m)\n• *${PREFIX()}every day 9pm review notes*\n• *${PREFIX()}every monday 8am gym*\nCancel: *${PREFIX()}every stop <id>*`);
  }
  const nextAt = nextOccurrence(parsed.schedule);
  const id = addRecurring(parsed.schedule, parsed.label, text, nextAt);
  return reply(sock, msg, `🔁 Recurring *#${id}* — "${text}" ${parsed.label}.\nFirst fire: ${fmtDT(nextAt)}.`);
}

async function handleRecurring(sock, msg) {
  const rows = listRecurring();
  if (!rows.length) return reply(sock, msg, `🔁 No recurring reminders. Add: *${PREFIX()}every day 9pm review notes*`);
  return reply(sock, msg,
    `🔁 *Recurring reminders:*\n${rows.map(r => `*#${r.id}* "${r.text}" — ${r.label} (next: ${fmtDT(r.next_at)})`).join('\n')}\n\n` +
    `Cancel: *${PREFIX()}every stop <id>*`);
}

// ── quick capture ────────────────────────────────────────────────────────────
async function handleIdea(sock, msg, args) {
  if ((args[0] || '').toLowerCase() === 'del') {
    const n = deleteIdea(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? '🗑️ Gone.' : `Usage: *${PREFIX()}idea del <id>*`);
  }
  const text = args.join(' ').trim();
  if (!text) return reply(sock, msg, `Usage: *${PREFIX()}idea <thought>* — zero friction, instant save.`);
  const id = addIdea(text);
  return reply(sock, msg, `✓ #${id}`);
}

async function handleIdeas(sock, msg, args) {
  // A TRAILING bare number is the page; everything before it is the search
  // keyword. So `ideas 2024 report` searches "2024 report" (numeric terms are
  // reachable) while `ideas report 2` pages the "report" search.
  const toks = [...args];
  let page = 1;
  if (toks.length && /^\d+$/.test(toks[toks.length - 1])) page = parseInt(toks.pop(), 10);
  const keyword = toks.join(' ').trim() || null;

  const rows = keyword ? searchIdeas(keyword) : listIdeas();
  if (!rows.length) return reply(sock, msg, keyword ? `💡 Nothing matching "*${keyword}*".` : `💡 No ideas captured yet. *${PREFIX()}idea <thought>*`);
  const { slice, page: p, pages, total } = paginate(rows, page, 10);
  // next-page hint keeps the keyword so paging a search doesn't flip to listing all
  const nextHint = pages > p ? ` · next: *${PREFIX()}ideas ${keyword ? keyword + ' ' : ''}${p + 1}*` : '';
  return reply(sock, msg,
    `💡 *Ideas${keyword ? ` matching "${keyword}"` : ''}* (${total}) — page ${p}/${pages}\n\n` +
    slice.map(i => `*#${i.id}* ${i.text}\n   _${fmtDT(i.ts)}_`).join('\n') +
    `\n\n*${PREFIX()}idea del <id>*${nextHint}`);
}

export const commands = [
  { name: 'todo', aliases: ['todos'], execute: handleTodo },
  { name: 'pomo', aliases: ['pomodoro'], execute: handlePomo },
  { name: 'every', execute: handleEvery },
  { name: 'recurring', execute: handleRecurring },
  { name: 'idea', execute: handleIdea },
  { name: 'ideas', execute: handleIdeas },
];
