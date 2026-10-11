import fs from 'fs';
import path from 'path';
import { wat } from '../lib/helpers.js';
import {
  getDb,
  GLOBAL, getConfig, setConfig, isToggled,
  dueScheduled, markScheduled, listScheduled,
  dueReminders, markReminder, listReminders,
  deadlinesNeedingReminder, setDeadlineFlag,
  dueHabits, bumpHabit, listHabits,
  timetableForDay, listDeadlines, listTrackedAnime,
  expiredMedia, clearMediaPaths, purgeOldText, MEDIA_DIR,
  getPomo, updatePomo,
  dueRecurring, bumpRecurring, listRecurring,
  listMonitors, updateMonitor,
  listBirthdays,
  dueAnime, bumpAnimeNext,
} from '../db/queries.js';
import { nextOccurrence } from '../commands/productivity.js';
import { airingBetween, animeById } from './anime.js';
import { fmtDT, fmtDuration, fetchJson, dmOwner, PREFIX } from '../lib/helpers.js';

const TICK_MS = 20 * 1000;
// Ephemeral media retention (HARDEN #4): default 15 min, override MEDIA_RETENTION_MIN
const MEDIA_RETENTION_MS = (parseInt(process.env.MEDIA_RETENTION_MIN, 10) || 15) * 60 * 1000;
// Cached message TEXT retention — powers !export / !summarize / .backfill history /
// NEXUS chat context / edit originals. Text rows are tiny (a few hundred bytes), so
// the default is generous; lower TEXT_RETENTION_DAYS if DB size ever matters.
// NOTE: this purge runs every tick, so it MUST outlast backfilled history or
// .backfill would silently lose everything it fetched.
const TEXT_RETENTION_MS = (parseInt(process.env.TEXT_RETENTION_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;
// Storage cap (HARDEN #4): default 500 MB, override MEDIA_CAP_MB
const MEDIA_CAP_BYTES = (parseInt(process.env.MEDIA_CAP_MB, 10) || 500) * 1024 * 1024;
const MISSED_NOTE_MS = 10 * 60 * 1000;   // one-shots later than this get a "(missed)" note
const RECURRING_SKIP_MS = 60 * 60 * 1000; // daily/weekly later than this roll forward silently
const BOOT_TS = Date.now();

let sock = null;
let started = false;
// Re-entrancy guard: a tick can run longer than TICK_MS (serial monitor pings,
// two 10s digest fetches). Without this, setInterval starts a second tick that
// re-reads rows the first hasn't marked yet → duplicate reminders/pomodoro.
let ticking = false;

export function setSock(s) { sock = s; }

export function startScheduler() {
  if (started) return;
  started = true;
  rehydrate();
  setInterval(tick, TICK_MS);
  console.log('[RF] scheduler running (20s tick)');
}

// HARDEN #1 — everything is DB-backed with absolute run_at timestamps and the
// 20s tick polls the DB, so restart survival is inherent. On boot we count what
// resumes and fix up anything that expired while offline.
function rehydrate() {
  try {
    let n = 0;
    n += listReminders().length;
    n += listScheduled().length;
    n += listRecurring().length;
    n += listHabits().filter(h => h.enabled).length;
    n += listMonitors().length;

    const p = getPomo();
    if (p?.active) {
      // if the whole remaining session couldn't still be running, end it cleanly
      const maxPhaseMs = (p.work_min + p.break_min + 5) * 60 * 1000;
      if (Date.now() - p.phase_ends_at > maxPhaseMs) {
        updatePomo({ active: 0 });
        pendingBootNotes.push('🍅 Your pomodoro expired while I was offline — session closed.');
      } else {
        n += 1; // resumes via the normal tick
      }
    }
    console.log(`[RF] Rehydrated ${n} scheduled items.`);
  } catch (err) {
    console.error('[RF] rehydrate failed:', err);
  }
}

// notes queued before the socket exists; flushed on the first connected tick
const pendingBootNotes = [];
async function flushBootNotes() {
  while (pendingBootNotes.length) {
    await dmOwner(sock, pendingBootNotes.shift());
  }
}

async function tick() {
  if (ticking) return;          // previous tick still running — skip this slot
  if (!sock?.user) return;
  ticking = true;
  const now = Date.now();
  try {
    try { await flushBootNotes(); } catch (e) { console.error('[RF] boot-notes:', e); }
    try { await fireScheduledMessages(now); } catch (e) { console.error('[RF] sched-msgs:', e); }
    try { await fireReminders(now); } catch (e) { console.error('[RF] reminders:', e); }
    try { await fireDeadlineReminders(now); } catch (e) { console.error('[RF] deadline-reminders:', e); }
    try { await fireHabits(now); } catch (e) { console.error('[RF] habits:', e); }
    try { await fireDailyDigest(now); } catch (e) { console.error('[RF] digest:', e); }
    try { await firePomodoro(now); } catch (e) { console.error('[RF] pomodoro:', e); }
    try { await fireRecurring(now); } catch (e) { console.error('[RF] recurring:', e); }
    try { await checkMonitorsDue(now); } catch (e) { console.error('[RF] monitors:', e); }
    try { await fireBirthdays(now); } catch (e) { console.error('[RF] birthdays:', e); }
    try { await fireAnimeReleases(now); } catch (e) { console.error('[RF] anime-releases:', e); }
    try { await fireNightlyBackup(now); } catch (e) { console.error('[RF] backup:', e); }
    try { await cleanupCache(now); } catch (e) { console.error('[RF] cache-cleanup:', e); }
  } finally {
    ticking = false;
  }
}

// ── pomodoro (single session — DECISIONS.md) ─────────────────────────────────
async function firePomodoro(now) {
  const p = getPomo();
  if (!p?.active || p.phase_ends_at > now) return;
  if (p.phase === 'work') {
    if (p.cycle >= p.cycles) {
      updatePomo({ active: 0 });
      await dmOwner(sock, `🍅 *Pomodoro complete!* ${p.cycles} cycle${p.cycles === 1 ? '' : 's'} of ${p.work_min}m done. Great session. 🎉`);
    } else {
      // Anchor the next phase to the one that just ended (not `now`), so a tick
      // firing up to ~20s late doesn't accumulate drift across cycles.
      updatePomo({ phase: 'break', phase_ends_at: p.phase_ends_at + p.break_min * 60000 });
      await dmOwner(sock, `🍅 Work done — *${p.break_min} min break* ⏸️ (cycle ${p.cycle}/${p.cycles})`);
    }
  } else {
    updatePomo({ phase: 'work', cycle: p.cycle + 1, phase_ends_at: p.phase_ends_at + p.work_min * 60000 });
    await dmOwner(sock, `🍅 Break over — *back in* 🔨 (cycle ${p.cycle + 1}/${p.cycles}, ${p.work_min}m)`);
  }
}

// ── recurring reminders ──────────────────────────────────────────────────────
// HARDEN #1: slots missed while offline roll forward to the next occurrence —
// never a burst. Very late daily/weekly slots (>1h) skip the DM entirely.
async function fireRecurring(now) {
  for (const r of dueRecurring(now)) {
    let schedule = null;
    try { schedule = JSON.parse(r.schedule); } catch { /* handled below */ }
    if (!schedule) {
      console.error(`[RF] recurring #${r.id} bad schedule row`);
      bumpRecurring(r.id, now + 24 * 3600 * 1000); // don't spin on a bad row
      continue;
    }
    const tooStale = schedule.type !== 'interval' && now - r.next_at > RECURRING_SKIP_MS;
    if (!tooStale) {
      await dmOwner(sock, `🔁 *${r.text}*\n_(${r.label} — #${r.id}, stop with "every stop ${r.id}")_`);
    }
    bumpRecurring(r.id, nextOccurrence(schedule, now));
  }
}

// ── uptime monitors (5-min interval — DECISIONS.md) ──────────────────────────
const MONITOR_INTERVAL_MS = 5 * 60 * 1000;

async function pingMonitor(m) {
  try {
    const res = await fetch(m.url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return { status: res.status < 400 ? 'up' : 'down', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'down', detail: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

// HARDEN #8: alert only on state transitions, and never more than once per
// cooldown window per monitor (flapping protection).
const MONITOR_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastMonitorAlert = new Map(); // monitor id → ts

/** Check monitors + alert on status change. Exported for !monitor check. */
export async function checkAllMonitors(sockRef = sock, force = false) {
  const now = Date.now();
  const all = listMonitors();
  // Drop alert-debounce entries for monitors that were deleted, so the map
  // doesn't retain ids forever.
  const liveIds = new Set(all.map(m => m.id));
  for (const id of lastMonitorAlert.keys()) if (!liveIds.has(id)) lastMonitorAlert.delete(id);
  const rows = all.filter(m => force || !m.last_checked || now - m.last_checked >= MONITOR_INTERVAL_MS);
  const results = [];
  for (const m of rows) {
    const { status, detail } = await pingMonitor(m);
    const changed = m.last_status !== status;
    updateMonitor(m.id, status, detail, changed);
    results.push({ ...m, status, detail });
    // alert on real transitions (or a first check that comes back down), debounced
    const shouldAlert = changed && (m.last_status !== null || status === 'down');
    const cooledDown = now - (lastMonitorAlert.get(m.id) || 0) >= MONITOR_ALERT_COOLDOWN_MS;
    if (sockRef && shouldAlert && cooledDown) {
      lastMonitorAlert.set(m.id, now);
      await dmOwner(sockRef, status === 'up'
        ? `🟢 *${m.name || m.url}* is back UP (${detail})`
        : `🔴 *${m.name || m.url}* is DOWN (${detail})\n${m.url}`);
    }
  }
  return results;
}
async function checkMonitorsDue() {
  await checkAllMonitors(sock, false);
}

// ── anime episode alerts (followed via .track add) ───────────────────────────
async function fireAnimeReleases(now) {
  for (const a of dueAnime(now)) {
    if (a.mal_id) {
      // AniList id stored in mal_id. Check status + the real next episode time.
      try {
        const info = await animeById(a.mal_id);
        if (info) {
          if (info.status && info.status !== 'RELEASING') {
            bumpAnimeNext(a.id, null); // finished/cancelled/hiatus → stop pinging
            await dmOwner(sock, `🎬 *${a.title}* is no longer airing — stopping episode pings. ("track remove ${a.id}" to drop it.)`);
            continue;
          }
          // schedule the next real episode (fallback: retry in a week)
          bumpAnimeNext(a.id, info.nextAt || now + 7 * 24 * 3600 * 1000);
          await dmOwner(sock,
            `🎬 *${a.title}* — new episode is out! 🍿${info.nextAt ? `\n_Next: ${fmtDT(info.nextAt)} WAT_` : ''}\n` +
            `_unfollow with "track remove ${a.id}"_`);
          continue;
        }
      } catch { /* AniList down — fall through to a simple weekly roll */ }
    }
    // no id or lookup failed: roll weekly without spamming
    let next = a.next_air_at + 7 * 24 * 3600 * 1000;
    while (next <= now) next += 7 * 24 * 3600 * 1000;
    bumpAnimeNext(a.id, next);
    await dmOwner(sock, `🎬 *${a.title}* — new episode is airing now! 🍿\n_unfollow with "track remove ${a.id}"_`);
  }
}

// ── birthdays (daily at 08:00; day-before on by default — DECISIONS.md) ──────
async function fireBirthdays(now) {
  const today = wat(now);
  if (today.hour() < 8) return;
  const key = today.format('YYYY-MM-DD');
  if (getConfig(GLOBAL, 'bday_last', '') === key) return;
  setConfig(GLOBAL, 'bday_last', key); // guard first so a crash can't spam

  const list = listBirthdays();
  const tomorrow = today.add(1, 'day');
  for (const b of list) {
    if (b.day === today.date() && b.month === today.month() + 1) {
      const age = b.year ? ` They turn *${today.year() - b.year}*.` : '';
      await dmOwner(sock, `🎉 *${b.name}'s birthday is TODAY!*${age} Send them something nice.`);
    } else if (b.notify_day_before && b.day === tomorrow.date() && b.month === tomorrow.month() + 1) {
      await dmOwner(sock, `🎂 Heads up: *${b.name}'s birthday is TOMORROW* (${String(b.day).padStart(2, '0')}/${String(b.month).padStart(2, '0')}).`);
    }
  }
}

async function fireScheduledMessages(now) {
  for (const row of dueScheduled(now)) {
    const late = now - row.run_at > MISSED_NOTE_MS ? `\n_(missed while offline — was due ${fmtDT(row.run_at)})_` : '';
    try {
      await sock.sendMessage(row.chat_id, { text: row.message + late });
      markScheduled(row.id, 'sent');
    } catch (err) {
      console.error(`[RF] scheduled #${row.id} failed:`, err.message);
      markScheduled(row.id, 'failed');
    }
  }
}

async function fireReminders(now) {
  for (const row of dueReminders(now)) {
    const late = now - row.run_at > MISSED_NOTE_MS ? `\n_(missed while offline — was due ${fmtDT(row.run_at)})_` : '';
    // Only mark sent if the DM actually went out. dmOwner swallows send errors
    // and returns undefined on failure; marking unconditionally would silently
    // lose the reminder if the socket is mid-reconnect. Left pending → retries.
    const ok = await dmOwner(sock, `⏰ *Reminder*\n${row.text}${late}`);
    if (ok) markReminder(row.id, 'sent');
  }
}

async function fireDeadlineReminders(now) {
  for (const d of deadlinesNeedingReminder(now, 24 * 3600 * 1000, 'reminded_24h')) {
    const ok = await dmOwner(sock, `📌 *Deadline in ${fmtDuration(d.due_at - now)}*\n${d.course} — ${d.task}\nDue: ${fmtDT(d.due_at)}`);
    if (ok) setDeadlineFlag(d.id, 'reminded_24h');
  }
  for (const d of deadlinesNeedingReminder(now, 2 * 3600 * 1000, 'reminded_2h')) {
    const ok = await dmOwner(sock, `🚨 *Deadline in ${fmtDuration(d.due_at - now)}!*\n${d.course} — ${d.task}\nDue: ${fmtDT(d.due_at)}`);
    if (ok) setDeadlineFlag(d.id, 'reminded_2h');
  }
}

async function fireHabits(now) {
  for (const h of dueHabits(now)) {
    const ok = await dmOwner(sock, `🔔 *Habit nudge:* ${h.text}`);
    // schedule from now so missed ticks don't burst-fire; only on successful send
    if (ok) bumpHabit(h.id, now + h.interval_min * 60 * 1000);
  }
}

// ── daily digest ─────────────────────────────────────────────────────────────
async function fireDailyDigest(now) {
  if (!isToggled(GLOBAL, 'digest', true)) return;
  const timeStr = getConfig(GLOBAL, 'digest_time', process.env.DIGEST_TIME || '06:30');
  // `hh || 6` / `mm || 30` would treat a legitimate 0 as "unset": 07:00 → 07:30,
  // 00:30 → 06:30. Guard on finiteness instead.
  const [hhRaw, mmRaw] = timeStr.split(':').map(Number);
  const hh = Number.isFinite(hhRaw) ? hhRaw : 6;
  const mm = Number.isFinite(mmRaw) ? mmRaw : 30;
  const today = wat(now);
  const fireAt = today.hour(hh).minute(mm).second(0);
  const todayKey = today.format('YYYY-MM-DD');
  if (today.valueOf() < fireAt.valueOf()) return;
  if (getConfig(GLOBAL, 'digest_last', '') === todayKey) return;
  setConfig(GLOBAL, 'digest_last', todayKey); // set first so a crash can't spam
  await dmOwner(sock, await buildDigest());
}

export async function buildDigest() {
  const now = wat();
  const lines = [`☀️ *Good morning! — ${now.format('dddd, DD MMM YYYY')}*`];

  // classes
  const isoDay = now.day() === 0 ? 7 : now.day();
  const classes = timetableForDay(isoDay);
  lines.push('', '📚 *Today\'s classes:*');
  lines.push(classes.length
    ? classes.map(c => `• ${c.start}–${c.end} ${c.course}${c.location ? ` @ ${c.location}` : ''}`).join('\n')
    : '_No classes today._');

  // deadlines within 48h
  const soon = listDeadlines().filter(d => d.due_at < Date.now() + 48 * 3600 * 1000);
  if (soon.length) {
    lines.push('', '📌 *Due soon:*');
    lines.push(soon.map(d => `• ${d.course} — ${d.task} (${fmtDT(d.due_at)})`).join('\n'));
  }

  // weather
  try {
    const city = getConfig(GLOBAL, 'weather_city', process.env.WEATHER_CITY || 'Lagos');
    const w = await fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {}, 10000);
    const cur = w.current_condition?.[0];
    if (cur) lines.push('', `🌤️ *${city}:* ${cur.weatherDesc?.[0]?.value}, ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C), rain chance ${w.weather?.[0]?.hourly?.[4]?.chanceofrain ?? '?'}%`);
  } catch { /* weather is optional */ }

  // anime — the shows the owner FOLLOWS that air today (AniList schedule)
  try {
    const start = Math.floor(now.startOf('day').valueOf() / 1000);
    const end = Math.floor(now.endOf('day').valueOf() / 1000);
    const all = await airingBetween(start, end);
    if (all.length) {
      const tracked = listTrackedAnime().map(t => t.title.toLowerCase()).filter(Boolean);
      const mine = tracked.length ? all.filter(s => tracked.some(t => s.title.toLowerCase().includes(t))) : [];
      if (mine.length) {
        lines.push('', '📺 *Your anime today:*', mine.map(s => `• ${s.title}`).join('\n'));
      } else {
        lines.push('', `📺 *Anime:* nothing you follow airs today — ${all.length} shows airing (*${PREFIX()}airing*)`);
      }
    }
  } catch { /* anime is optional */ }

  lines.push('', '_— 𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2_');
  return lines.join('\n');
}

// ── DB backup (HARDEN #9): nightly at 02:00 WAT, keep last 7 ─────────────────
const BACKUP_DIR = path.join(MEDIA_DIR, '../backups');
const BACKUP_KEEP = 7;

export async function makeBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `redflag-${wat().format('YYYYMMDD-HHmm')}.db`;
  const dest = path.join(BACKUP_DIR, name);
  await getDb().backup(dest); // consistent copy even under WAL
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
  while (files.length > BACKUP_KEEP) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch { /* skip */ }
  }
  return dest;
}

async function fireNightlyBackup(now) {
  const t = wat(now);
  if (t.hour() < 2) return;
  const key = t.format('YYYY-MM-DD');
  if (getConfig(GLOBAL, 'backup_last', '') === key) return;
  // Mark done only AFTER a successful backup — setting the guard first meant a
  // failed backup (disk full, locked file) was skipped for the whole day.
  const dest = await makeBackup();
  setConfig(GLOBAL, 'backup_last', key);
  console.log('[RF] nightly backup:', dest);
}

// ── cache cleanup (anti-delete retention + storage cap — HARDEN #4) ──────────
let lastCapSweep = 0;
const CAP_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // full dir stat/sweep at most every 5 min
async function cleanupCache(now) {
  const rows = expiredMedia(now - MEDIA_RETENTION_MS);
  const cleared = [];
  for (const r of rows) {
    try { if (r.media_path && fs.existsSync(r.media_path)) fs.unlinkSync(r.media_path); } catch { /* locked */ }
    cleared.push(r.msg_id);
  }
  if (cleared.length) clearMediaPaths(cleared);
  purgeOldText(now - TEXT_RETENTION_MS);

  // The whole-directory stat/sweep is synchronous and blocks the event loop, so
  // don't run it every 20s tick — only every few minutes. The retention purge
  // above (indexed DB query) still runs each tick.
  if (now - lastCapSweep < CAP_SWEEP_INTERVAL_MS) return;
  lastCapSweep = now;

  // hard cap on the ephemeral media dir — delete oldest first, warn the owner
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .map(f => {
        const p = path.join(MEDIA_DIR, f);
        const st = fs.statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((s, f) => s + f.size, 0);
    let evicted = 0;
    for (const f of files) {
      if (total <= MEDIA_CAP_BYTES) break;
      try { fs.unlinkSync(f.p); total -= f.size; evicted++; } catch { /* skip */ }
    }
    if (evicted > 0) {
      const key = wat(now).format('YYYY-MM-DD');
      if (getConfig(GLOBAL, 'cap_warned', '') !== key) {
        setConfig(GLOBAL, 'cap_warned', key);
        await dmOwner(sock,
          `⚠️ *Storage cap hit* — media cache passed ${Math.round(MEDIA_CAP_BYTES / 1024 / 1024)} MB; ` +
          `I deleted ${evicted} oldest cached file${evicted === 1 ? '' : 's'}. Raise MEDIA_CAP_MB in config.env if this keeps happening.`);
      }
    }
  } catch { /* dir may not exist yet */ }
}
