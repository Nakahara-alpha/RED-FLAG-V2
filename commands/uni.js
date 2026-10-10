// Phase 4 — Uni life (owner-only)
import fs from 'fs';
import path from 'path';
import { wat } from '../lib/helpers.js';
import {
  GLOBAL, getConfig, setConfig,
  addTimetable, timetableForDay, timetableAll, clearTimetableDay, removeTimetableEntry,
  addDeadline, listDeadlines, markDeadlineDone,
  addNote, notesByTag, noteTags, deleteNote,
  addExam, listExams, deleteExam,
  addGpa, gpaHistory,
} from '../db/queries.js';
import { reply, PREFIX, parseWhen, fmtDT, fmtDuration } from '../lib/helpers.js';

const DAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const isoToday = () => (wat().day() === 0 ? 7 : wat().day());

// Validate + zero-pad an "H:MM"/"HH:MM" clock string. Returns "HH:MM" or null.
// Padding matters: `start` is a TEXT column sorted lexically, so an unpadded
// "8:00" sorts AFTER "10:00" and breaks ordering / "next class". Also rejects
// impossible times like 25:99 that the loose regex would otherwise accept.
function normHM(s) {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// ── timetable ────────────────────────────────────────────────────────────────
async function handleTimetable(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'add') {
    // !tt add mon 08:00-10:00 MTH202 @ LT1
    const day = DAYS[(args[1] || '').slice(0, 3).toLowerCase()];
    const time = (args[2] || '').match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    const start = time ? normHM(time[1]) : null;
    const end = time ? normHM(time[2]) : null;
    const rest = args.slice(3).join(' ');
    const [course, location] = rest.split('@').map(s => s.trim());
    if (!day || !start || !end || !course) {
      return reply(sock, msg, `Usage: *${PREFIX()}tt add <day> <start-end> <course> [@ location]*\ne.g. \`${PREFIX()}tt add mon 08:00-10:00 MTH202 @ LT1\``);
    }
    addTimetable(day, start, end, course, location || null);
    return reply(sock, msg, `📚 Added: ${DAY_NAMES[day]} ${start}–${end} *${course}*${location ? ` @ ${location}` : ''}`);
  }
  if (sub === 'clear') {
    const day = DAYS[(args[1] || '').slice(0, 3).toLowerCase()];
    if (!day) return reply(sock, msg, `Usage: *${PREFIX()}tt clear <day>*`);
    const n = clearTimetableDay(day);
    return reply(sock, msg, `🧹 Cleared ${n} entr${n === 1 ? 'y' : 'ies'} for ${DAY_NAMES[day]}.`);
  }
  if (sub === 'remove') {
    const id = parseInt(args[1], 10);
    if (!id) return reply(sock, msg, `Usage: *${PREFIX()}tt remove <id>*`);
    const n = removeTimetableEntry(id);
    return reply(sock, msg, n ? `✅ Removed entry #${id}.` : `⚠️ No entry #${id}.`);
  }

  const rows = timetableAll();
  if (!rows.length) return reply(sock, msg, `📚 Timetable is empty. Add with *${PREFIX()}tt add mon 08:00-10:00 MTH202 @ LT1*`);
  const byDay = {};
  for (const r of rows) (byDay[r.day] ||= []).push(r);
  const out = Object.keys(byDay).sort().map(d =>
    `*${DAY_NAMES[d]}*\n${byDay[d].map(r => `  #${r.id} ${r.start}–${r.end} ${r.course}${r.location ? ` @ ${r.location}` : ''}`).join('\n')}`
  ).join('\n');
  return reply(sock, msg, `📚 *Weekly timetable:*\n${out}`);
}

async function handleToday(sock, msg) {
  const rows = timetableForDay(isoToday());
  if (!rows.length) return reply(sock, msg, `📚 No classes today (${DAY_NAMES[isoToday()]}). 🎉`);
  return reply(sock, msg, `📚 *Today (${DAY_NAMES[isoToday()]}):*\n${rows.map(r => `• ${r.start}–${r.end} *${r.course}*${r.location ? ` @ ${r.location}` : ''}`).join('\n')}`);
}

async function handleNext(sock, msg) {
  const now = wat();
  for (let offset = 0; offset < 7; offset++) {
    const day = ((isoToday() - 1 + offset) % 7) + 1;
    const rows = timetableForDay(day);
    for (const r of rows) {
      const [h, m] = r.start.split(':').map(Number);
      const start = now.add(offset, 'day').hour(h).minute(m).second(0);
      if (start.valueOf() > now.valueOf()) {
        return reply(sock, msg,
          `⏭️ *Next class:* ${r.course}${r.location ? ` @ ${r.location}` : ''}\n` +
          `🕒 ${offset === 0 ? 'Today' : DAY_NAMES[day]} ${r.start} — in *${fmtDuration(start.valueOf() - now.valueOf())}*`);
      }
    }
  }
  return reply(sock, msg, '📚 No upcoming classes in your timetable.');
}

// ── deadlines ────────────────────────────────────────────────────────────────
async function handleDue(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'add') {
    // !due add CSC201 | assignment 2 | 2026-07-10 18:00
    const parts = args.slice(1).join(' ').split('|').map(s => s.trim());
    if (parts.length < 3) return reply(sock, msg, `Usage: *${PREFIX()}due add <course> | <task> | <when>*\ne.g. \`${PREFIX()}due add CSC201 | assignment 2 | 2026-07-10 18:00\``);
    const dueAt = parseWhen(parts[2]);
    if (!dueAt) return reply(sock, msg, '⚠️ Couldn\'t parse that date. Try `2026-07-10 18:00`, `10/07 18:00` or `tomorrow 12:00`.');
    if (dueAt <= Date.now()) return reply(sock, msg, '⏰ That due date is already in the past — I can only remind you about future deadlines.');
    const id = addDeadline(parts[0], parts[1], dueAt);
    return reply(sock, msg, `📌 Deadline *#${id}* saved: ${parts[0]} — ${parts[1]}\nDue ${fmtDT(dueAt)} (in ${fmtDuration(dueAt - Date.now())}). I'll remind you 24h and 2h before.`);
  }
  if (sub === 'done') {
    const id = parseInt(args[1], 10);
    if (!id) return reply(sock, msg, `Usage: *${PREFIX()}due done <id>*`);
    const n = markDeadlineDone(id);
    return reply(sock, msg, n ? `✅ #${id} done. Nice.` : `⚠️ No deadline #${id}.`);
  }
  const rows = listDeadlines();
  if (!rows.length) return reply(sock, msg, `📌 No pending deadlines. Add: *${PREFIX()}due add <course> | <task> | <when>*`);
  const now = Date.now();
  const lines = rows.map(d => {
    const left = d.due_at - now;
    const flag = left < 0 ? '🔴 OVERDUE' : left < 24 * 3600e3 ? '🟠' : left < 72 * 3600e3 ? '🟡' : '🟢';
    return `${flag} *#${d.id}* ${d.course} — ${d.task}\n   ${fmtDT(d.due_at)} (${left < 0 ? fmtDuration(-left) + ' ago' : 'in ' + fmtDuration(left)})`;
  });
  return reply(sock, msg, `📌 *Deadlines:*\n${lines.join('\n')}\n\nDone: *${PREFIX()}due done <id>*`);
}

// ── GPA (5.0 scale: A=5 B=4 C=3 D=2 E=1 F=0) ────────────────────────────────
const GRADE_POINTS = { a: 5, b: 4, c: 3, d: 2, e: 1, f: 0 };
async function handleGpa(sock, msg, args) {
  if ((args[0] || '').toLowerCase() === 'history') {
    const rows = gpaHistory();
    if (!rows.length) return reply(sock, msg, '🎓 No saved semesters yet.');
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    const totalPoints = rows.reduce((s, r) => s + r.points, 0);
    const cgpa = totalUnits ? (totalPoints / totalUnits) : 0;
    return reply(sock, msg,
      `🎓 *GPA history:*\n${rows.map(r => `• ${r.semester || '?'} — GPA ${r.gpa.toFixed(2)} (${r.units} units)`).join('\n')}\n\n` +
      `📊 *CGPA: ${cgpa.toFixed(2)}* over ${totalUnits} units`);
  }

  // pairs: <units> <grade> ... [save <semester>]
  let saveIdx = args.findIndex(a => a.toLowerCase() === 'save');
  const semester = saveIdx >= 0 ? (args.slice(saveIdx + 1).join(' ') || wat().format('YYYY-MM')) : null;
  const pairs = saveIdx >= 0 ? args.slice(0, saveIdx) : args;
  if (pairs.length < 2 || pairs.length % 2 !== 0) {
    return reply(sock, msg,
      `Usage: *${PREFIX()}gpa <units> <grade> [<units> <grade> ...]* — 5.0 scale (A=5…F=0)\n` +
      `e.g. \`${PREFIX()}gpa 3 A 2 B 4 C\`\nAppend \`save 2025/26-1\` to record it. *${PREFIX()}gpa history* for CGPA.`);
  }
  let units = 0, points = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const u = parseInt(pairs[i], 10);
    const g = GRADE_POINTS[(pairs[i + 1] || '').toLowerCase()];
    if (!u || g === undefined) return reply(sock, msg, `⚠️ Bad pair: "${pairs[i]} ${pairs[i + 1]}" — use \`<units> <A-F>\`.`);
    units += u;
    points += u * g;
  }
  const gpa = points / units;
  let extra = '';
  if (semester) {
    addGpa(semester, gpa, units, points);
    const rows = gpaHistory();
    const tu = rows.reduce((s, r) => s + r.units, 0);
    const tp = rows.reduce((s, r) => s + r.points, 0);
    extra = `\n💾 Saved as *${semester}*. CGPA: *${(tp / tu).toFixed(2)}*`;
  }
  const cls = gpa >= 4.5 ? 'First Class 🥇' : gpa >= 3.5 ? 'Second Upper 🥈' : gpa >= 2.4 ? 'Second Lower' : gpa >= 1.5 ? 'Third Class' : gpa >= 1.0 ? 'Pass' : 'Fail ⚠️';
  return reply(sock, msg, `🎓 *GPA: ${gpa.toFixed(2)}* (${units} units) — ${cls}${extra}`);
}

// `.cgpa` with no grade pairs shows the cumulative history/CGPA; with pairs it
// behaves exactly like `.gpa` (so `.cgpa 3 A 2 B` still works).
async function handleCgpa(sock, msg, args) {
  if (!args.length) return handleGpa(sock, msg, ['history']);
  return handleGpa(sock, msg, args);
}

// ── notes ────────────────────────────────────────────────────────────────────
async function handleNote(sock, msg, args) {
  const tag = args[0];
  const text = args.slice(1).join(' ').trim();
  if (!tag || !text) return reply(sock, msg, `Usage: *${PREFIX()}note <tag> <text>*`);
  const id = addNote(tag, text);
  return reply(sock, msg, `📝 Note *#${id}* saved under *${tag.toLowerCase()}*.`);
}
async function handleNotes(sock, msg, args) {
  const tag = args[0];
  if ((tag || '').toLowerCase() === 'del') {
    const id = parseInt(args[1], 10);
    const n = id ? deleteNote(id) : 0;
    return reply(sock, msg, n ? `🗑️ Note #${id} deleted.` : `Usage: *${PREFIX()}notes del <id>*`);
  }
  if (tag) {
    const rows = notesByTag(tag);
    if (!rows.length) return reply(sock, msg, `📝 No notes under *${tag}*.`);
    return reply(sock, msg, `📝 *${tag.toLowerCase()}:*\n${rows.map(r => `*#${r.id}* ${r.text} _(${fmtDT(r.ts)})_`).join('\n')}`);
  }
  const tags = noteTags();
  return reply(sock, msg, tags.length
    ? `📝 *Note tags:*\n${tags.map(t => `• ${t.tag} (${t.n})`).join('\n')}\n\nView: *${PREFIX()}notes <tag>*`
    : `📝 No notes yet. Save one: *${PREFIX()}note ideas buy a whiteboard*`);
}

// ── exams / countdown ────────────────────────────────────────────────────────
async function handleExam(sock, msg, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'add') {
    const course = args[1];
    const when = parseWhen(args.slice(2).join(' '));
    if (!course || !when) return reply(sock, msg, `Usage: *${PREFIX()}exam add <course> <date>* — e.g. \`${PREFIX()}exam add CSC201 2026-07-20 09:00\``);
    const id = addExam(course, when);
    return reply(sock, msg, `🧪 Exam *#${id}* saved: ${course} on ${fmtDT(when)}.`);
  }
  if (sub === 'remove') {
    const n = deleteExam(parseInt(args[1], 10) || 0);
    return reply(sock, msg, n ? '✅ Removed.' : `Usage: *${PREFIX()}exam remove <id>*`);
  }
  return handleCountdown(sock, msg);
}
async function handleCountdown(sock, msg) {
  const rows = listExams().filter(e => e.exam_at > Date.now() - 12 * 3600e3);
  if (!rows.length) return reply(sock, msg, `🧪 No exams stored. Add: *${PREFIX()}exam add CSC201 2026-07-20 09:00*`);
  const todayWat = wat().startOf('day');
  return reply(sock, msg, `⏳ *Exam countdown:*\n${rows.map(e => {
    // Whole-day difference on WAT calendar dates — avoids the Math.ceil
    // off-by-one that labelled an exam later today as "1 day".
    const days = wat(e.exam_at).startOf('day').diff(todayWat, 'day');
    const when = days < 0 ? 'just passed' : days === 0 ? 'TODAY 🔥' : `${days} day${days === 1 ? '' : 's'}`;
    return `• *${e.course}* — ${fmtDT(e.exam_at)} (${when})`;
  }).join('\n')}`);
}

// ── past questions ───────────────────────────────────────────────────────────
async function handlePq(sock, msg, args) {
  if ((args[0] || '').toLowerCase() === 'setdir') {
    const dir = args.slice(1).join(' ').trim();
    if (!dir || !fs.existsSync(dir)) return reply(sock, msg, '⚠️ That folder doesn\'t exist.');
    setConfig(GLOBAL, 'pq_dir', dir);
    return reply(sock, msg, `📂 Past-question folder set to:\n${dir}`);
  }
  const dir = getConfig(GLOBAL, 'pq_dir', process.env.PQ_DIR || '');
  if (!dir || !fs.existsSync(dir)) {
    return reply(sock, msg, `📂 No PQ folder configured. Set one: *${PREFIX()}pq setdir C:\\path\\to\\pdfs* (or PQ_DIR in config.env).`);
  }
  const course = (args[0] || '').toLowerCase();
  const year = args[1] || '';
  if (!course) return reply(sock, msg, `Usage: *${PREFIX()}pq <course> [year]* — e.g. \`${PREFIX()}pq csc201 2023\``);

  const matches = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isSymbolicLink()) continue; // don't follow symlinks (loops / escapes the folder)
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.pdf$/i.test(f.name)
        && f.name.toLowerCase().includes(course)
        && (!year || f.name.includes(year))) matches.push(p);
    }
  })(dir);

  if (!matches.length) return reply(sock, msg, `📂 No PDF matching "*${course}${year ? ' ' + year : ''}*" found.`);
  const MAX_PQ_BYTES = 90 * 1024 * 1024; // keep under WhatsApp's ~100 MB document limit
  for (const p of matches.slice(0, 3)) {
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_PQ_BYTES) {
        await reply(sock, msg, `⚠️ ${path.basename(p)} is too large to send (${Math.round(st.size / 1024 / 1024)} MB).`);
        continue;
      }
      await reply(sock, msg, {
        document: fs.readFileSync(p),
        fileName: path.basename(p),
        mimetype: 'application/pdf',
      });
    } catch {
      await reply(sock, msg, `⚠️ Couldn't read ${path.basename(p)}.`);
    }
  }
  if (matches.length > 3) await reply(sock, msg, `📂 ${matches.length - 3} more matches — narrow with a year.`);
}

export const commands = [
  { name: 'tt', aliases: ['timetable'], execute: handleTimetable },
  { name: 'today', execute: handleToday },
  { name: 'next', execute: handleNext },
  { name: 'due', execute: handleDue },
  { name: 'gpa', execute: handleGpa },
  { name: 'cgpa', execute: handleCgpa },
  { name: 'note', execute: handleNote },
  { name: 'notes', execute: handleNotes },
  { name: 'exam', execute: handleExam },
  { name: 'countdown', execute: handleCountdown },
  { name: 'pq', execute: handlePq },
];
