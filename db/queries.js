import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'redflag.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
export const MEDIA_DIR = path.join(__dirname, '../data/media');
export const PIN_DIR = path.join(__dirname, '../data/pins');

let _db = null;

export function getDb() {
  if (_db) return _db;
  for (const dir of [MEDIA_DIR, PIN_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  const migrations = [
    // anime follow: release notifications need the MAL id + broadcast schedule
    'ALTER TABLE tracked_anime ADD COLUMN mal_id INTEGER',
    'ALTER TABLE tracked_anime ADD COLUMN broadcast TEXT',
    'ALTER TABLE tracked_anime ADD COLUMN next_air_at INTEGER',
    // group activity: record when we FIRST saw each member so NEXUS can honestly
    // say "no activity since <date>" instead of "never messaged".
    'ALTER TABLE msg_stats ADD COLUMN first_ts INTEGER',
  ];
  for (const m of migrations) {
    try { _db.exec(m); } catch { /* already applied */ }
  }
  return _db;
}

export function tx(fn) {
  return getDb().transaction(fn)();
}

// Escape LIKE metacharacters so a user keyword containing % or _ matches those
// characters literally (used with `ESCAPE '\'`), not as wildcards.
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

// -- config / per-chat toggles ------------------------------------------------
// Backed by an in-memory cache loaded once from DB, so the per-message pipeline
// never hits SQLite for toggle checks (HARDEN #3). Writes go DB-first, then cache.
export const GLOBAL = 'global';

let _cfgCache = null;
function cfgCache() {
  if (!_cfgCache) {
    _cfgCache = new Map();
    for (const r of getDb().prepare('SELECT chat_id, key, value FROM config').all()) {
      _cfgCache.set(r.chat_id + '\x00' + r.key, r.value);
    }
  }
  return _cfgCache;
}

export function getConfig(chatId, key, def = null) {
  const v = cfgCache().get(chatId + '\x00' + key);
  return v === undefined ? def : v;
}
export function setConfig(chatId, key, value) {
  getDb().prepare('INSERT INTO config (chat_id,key,value) VALUES (?,?,?) ON CONFLICT(chat_id,key) DO UPDATE SET value=excluded.value')
    .run(chatId, key, String(value));
  cfgCache().set(chatId + '\x00' + key, String(value));
}
export function delConfig(chatId, key) {
  getDb().prepare('DELETE FROM config WHERE chat_id=? AND key=?').run(chatId, key);
  cfgCache().delete(chatId + '\x00' + key);
}
export function isToggled(chatId, key, defaultOn = false) {
  const v = getConfig(chatId, key, null);
  if (v === null) return defaultOn;
  return v === '1' || v === 'true' || v === 'on';
}

// -- antiword -------------------------------------------------------------------
export function addAntiword(chatId, word) {
  getDb().prepare('INSERT OR IGNORE INTO antiword (chat_id,word) VALUES (?,?)').run(chatId, word.toLowerCase());
}
export function removeAntiword(chatId, word) {
  return getDb().prepare('DELETE FROM antiword WHERE chat_id=? AND word=?').run(chatId, word.toLowerCase()).changes;
}
export function listAntiwords(chatId) {
  return getDb().prepare('SELECT word FROM antiword WHERE chat_id=?').all(chatId).map(r => r.word);
}

// -- antilink whitelist + strikes -----------------------------------------------
export function addWhitelist(chatId, pattern) {
  getDb().prepare('INSERT OR IGNORE INTO antilink_whitelist (chat_id,pattern) VALUES (?,?)').run(chatId, pattern.toLowerCase());
}
export function removeWhitelist(chatId, pattern) {
  return getDb().prepare('DELETE FROM antilink_whitelist WHERE chat_id=? AND pattern=?').run(chatId, pattern.toLowerCase()).changes;
}
export function listWhitelist(chatId) {
  return getDb().prepare('SELECT pattern FROM antilink_whitelist WHERE chat_id=?').all(chatId).map(r => r.pattern);
}
export function bumpLinkStrike(chatId, userId) {
  getDb().prepare(`INSERT INTO link_strikes (chat_id,user_id,count) VALUES (?,?,1)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET count=count+1`).run(chatId, userId);
  return getDb().prepare('SELECT count FROM link_strikes WHERE chat_id=? AND user_id=?').get(chatId, userId).count;
}
export function resetLinkStrikes(chatId, userId) {
  getDb().prepare('DELETE FROM link_strikes WHERE chat_id=? AND user_id=?').run(chatId, userId);
}

// -- keyword alerts ---------------------------------------------------------------
export function addAlert(keyword) {
  getDb().prepare('INSERT OR IGNORE INTO alerts (keyword) VALUES (?)').run(keyword.toLowerCase());
}
export function removeAlert(keyword) {
  return getDb().prepare('DELETE FROM alerts WHERE keyword=?').run(keyword.toLowerCase()).changes;
}
export function listAlerts() {
  return getDb().prepare('SELECT keyword FROM alerts').all().map(r => r.keyword);
}

// -- message cache (anti-delete / edits / export / summarize) --------------------
export function cacheMsg(row) {
  getDb().prepare(`INSERT OR REPLACE INTO msg_cache
    (msg_id, chat_id, sender, push_name, type, content, media_path, from_me, ts)
    VALUES (@msg_id, @chat_id, @sender, @push_name, @type, @content, @media_path, @from_me, @ts)`).run(row);
}
export function getCachedMsg(msgId) {
  return getDb().prepare('SELECT * FROM msg_cache WHERE msg_id=?').get(msgId);
}
export function setCachedMediaPath(msgId, mediaPath) {
  getDb().prepare('UPDATE msg_cache SET media_path=? WHERE msg_id=?').run(mediaPath, msgId);
}
export function setCachedContent(msgId, content) {
  getDb().prepare('UPDATE msg_cache SET content=? WHERE msg_id=?').run(content, msgId);
}
export function recentMsgs(chatId, n) {
  return getDb().prepare('SELECT * FROM msg_cache WHERE chat_id=? ORDER BY ts DESC LIMIT ?').all(chatId, n).reverse();
}
// Oldest cached message in a chat — the seed `.backfill` needs: WhatsApp's
// on-demand history request asks for messages BEFORE a key/timestamp we already hold.
export function oldestCachedMsg(chatId) {
  return getDb().prepare('SELECT * FROM msg_cache WHERE chat_id=? ORDER BY ts ASC LIMIT 1').get(chatId);
}
export function countCachedMsgs(chatId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM msg_cache WHERE chat_id=?').get(chatId)?.n || 0;
}
// The owner's OWN recent activity (messages the bot saw them send), newest first.
export function ownerLastActivity(limit = 1) {
  return getDb().prepare('SELECT chat_id, content, ts FROM msg_cache WHERE from_me=1 ORDER BY ts DESC LIMIT ?').all(limit);
}
// Per-chat: when the owner was last active in each chat (their own messages).
export function ownerActivityByChat(limit = 10) {
  return getDb().prepare(`SELECT chat_id, MAX(ts) AS last_ts, COUNT(*) AS n
    FROM msg_cache WHERE from_me=1 GROUP BY chat_id ORDER BY last_ts DESC LIMIT ?`).all(limit);
}
export function expiredMedia(cutoffTs) {
  return getDb().prepare('SELECT msg_id, media_path FROM msg_cache WHERE media_path IS NOT NULL AND ts < ?').all(cutoffTs);
}
export function clearMediaPaths(msgIds) {
  if (!msgIds.length) return;
  const stmt = getDb().prepare('UPDATE msg_cache SET media_path=NULL WHERE msg_id=?');
  tx(() => { for (const id of msgIds) stmt.run(id); });
}
export function purgeOldText(cutoffTs) {
  getDb().prepare('DELETE FROM msg_cache WHERE ts < ? AND media_path IS NULL').run(cutoffTs);
}

// -- scheduled messages -----------------------------------------------------------
export function addScheduled(chatId, runAt, message) {
  return getDb().prepare('INSERT INTO scheduled (chat_id,run_at,message,created_at) VALUES (?,?,?,?)')
    .run(chatId, runAt, message, Date.now()).lastInsertRowid;
}
export function listScheduled() {
  return getDb().prepare("SELECT * FROM scheduled WHERE status='pending' ORDER BY run_at").all();
}
export function cancelScheduled(id) {
  return getDb().prepare("UPDATE scheduled SET status='cancelled' WHERE id=? AND status='pending'").run(id).changes;
}
export function dueScheduled(now) {
  return getDb().prepare("SELECT * FROM scheduled WHERE status='pending' AND run_at<=?").all(now);
}
export function markScheduled(id, status) {
  getDb().prepare('UPDATE scheduled SET status=? WHERE id=?').run(status, id);
}

// -- reminders ----------------------------------------------------------------------
export function addReminder(runAt, text) {
  return getDb().prepare('INSERT INTO reminders (run_at,text,created_at) VALUES (?,?,?)')
    .run(runAt, text, Date.now()).lastInsertRowid;
}
export function listReminders() {
  return getDb().prepare("SELECT * FROM reminders WHERE status='pending' ORDER BY run_at").all();
}
export function dueReminders(now) {
  return getDb().prepare("SELECT * FROM reminders WHERE status='pending' AND run_at<=?").all(now);
}
export function markReminder(id, status) {
  getDb().prepare('UPDATE reminders SET status=? WHERE id=?').run(status, id);
}

// -- timetable ------------------------------------------------------------------------
export function addTimetable(day, start, end, course, location) {
  return getDb().prepare('INSERT INTO timetable (day,start,end,course,location) VALUES (?,?,?,?,?)')
    .run(day, start, end, course, location).lastInsertRowid;
}
export function timetableForDay(day) {
  return getDb().prepare('SELECT * FROM timetable WHERE day=? ORDER BY start').all(day);
}
export function timetableAll() {
  return getDb().prepare('SELECT * FROM timetable ORDER BY day, start').all();
}
export function clearTimetableDay(day) {
  return getDb().prepare('DELETE FROM timetable WHERE day=?').run(day).changes;
}
export function removeTimetableEntry(id) {
  return getDb().prepare('DELETE FROM timetable WHERE id=?').run(id).changes;
}

// -- deadlines --------------------------------------------------------------------------
export function addDeadline(course, task, dueAt) {
  return getDb().prepare('INSERT INTO deadlines (course,task,due_at) VALUES (?,?,?)')
    .run(course, task, dueAt).lastInsertRowid;
}
export function listDeadlines(includeDone = false) {
  return includeDone
    ? getDb().prepare('SELECT * FROM deadlines ORDER BY due_at').all()
    : getDb().prepare('SELECT * FROM deadlines WHERE done=0 ORDER BY due_at').all();
}
export function markDeadlineDone(id) {
  return getDb().prepare('UPDATE deadlines SET done=1 WHERE id=?').run(id).changes;
}
// Internal flag columns for deadline reminders. Column names can't be bound as
// SQL parameters, so they're interpolated — guard against anything outside this
// known set so a future caller can't turn this into an injection point.
const DEADLINE_FLAGS = new Set(['reminded_24h', 'reminded_2h']);
export function deadlinesNeedingReminder(now, windowMs, flagCol) {
  if (!DEADLINE_FLAGS.has(flagCol)) throw new Error(`invalid deadline flag column: ${flagCol}`);
  return getDb().prepare(
    `SELECT * FROM deadlines WHERE done=0 AND ${flagCol}=0 AND due_at>? AND due_at<=?`
  ).all(now, now + windowMs);
}
export function setDeadlineFlag(id, flagCol) {
  if (!DEADLINE_FLAGS.has(flagCol)) throw new Error(`invalid deadline flag column: ${flagCol}`);
  getDb().prepare(`UPDATE deadlines SET ${flagCol}=1 WHERE id=?`).run(id);
}

// -- notes ----------------------------------------------------------------------------
export function addNote(tag, text) {
  return getDb().prepare('INSERT INTO notes (tag,text,ts) VALUES (?,?,?)').run(tag.toLowerCase(), text, Date.now()).lastInsertRowid;
}
export function notesByTag(tag) {
  return getDb().prepare('SELECT * FROM notes WHERE tag=? ORDER BY ts').all(tag.toLowerCase());
}
export function noteTags() {
  return getDb().prepare('SELECT tag, COUNT(*) n FROM notes GROUP BY tag ORDER BY tag').all();
}
export function deleteNote(id) {
  return getDb().prepare('DELETE FROM notes WHERE id=?').run(id).changes;
}

// -- exams ----------------------------------------------------------------------------
export function addExam(course, examAt) {
  return getDb().prepare('INSERT INTO exams (course,exam_at) VALUES (?,?)').run(course, examAt).lastInsertRowid;
}
export function listExams() {
  return getDb().prepare('SELECT * FROM exams ORDER BY exam_at').all();
}
export function deleteExam(id) {
  return getDb().prepare('DELETE FROM exams WHERE id=?').run(id).changes;
}

// -- GPA ------------------------------------------------------------------------------
// Re-saving a semester REPLACES its row rather than inserting a duplicate —
// otherwise a corrected grade is counted twice in the all-rows CGPA sum.
export function addGpa(semester, gpa, units, points) {
  const db = getDb();
  return tx(() => {
    db.prepare('DELETE FROM gpa_history WHERE semester=?').run(semester);
    return db.prepare('INSERT INTO gpa_history (semester,gpa,units,points,ts) VALUES (?,?,?,?,?)')
      .run(semester, gpa, units, points, Date.now()).lastInsertRowid;
  });
}
export function gpaHistory() {
  return getDb().prepare('SELECT * FROM gpa_history ORDER BY ts').all();
}

// -- expenses -------------------------------------------------------------------------
export function addExpense(amount, category) {
  return getDb().prepare('INSERT INTO expenses (amount,category,ts) VALUES (?,?,?)')
    .run(amount, category.toLowerCase(), Date.now()).lastInsertRowid;
}
export function expensesSince(ts) {
  return getDb().prepare('SELECT * FROM expenses WHERE ts>=? ORDER BY ts').all(ts);
}

// -- warns ----------------------------------------------------------------------------
export function bumpWarn(chatId, userId) {
  getDb().prepare(`INSERT INTO warns (chat_id,user_id,count) VALUES (?,?,1)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET count=count+1`).run(chatId, userId);
  return getDb().prepare('SELECT count FROM warns WHERE chat_id=? AND user_id=?').get(chatId, userId).count;
}
export function getWarns(chatId, userId) {
  const row = getDb().prepare('SELECT count FROM warns WHERE chat_id=? AND user_id=?').get(chatId, userId);
  return row ? row.count : 0;
}
export function resetWarns(chatId, userId) {
  return getDb().prepare('DELETE FROM warns WHERE chat_id=? AND user_id=?').run(chatId, userId).changes;
}

// -- welcome --------------------------------------------------------------------------
export function getWelcome(chatId) {
  return getDb().prepare('SELECT * FROM welcome WHERE chat_id=?').get(chatId);
}
export function setWelcome(chatId, patch) {
  const cur = getWelcome(chatId) || { chat_id: chatId, join_text: null, leave_text: null, enabled: 0 };
  const next = { ...cur, ...patch };
  getDb().prepare(`INSERT INTO welcome (chat_id,join_text,leave_text,enabled) VALUES (@chat_id,@join_text,@leave_text,@enabled)
    ON CONFLICT(chat_id) DO UPDATE SET join_text=@join_text, leave_text=@leave_text, enabled=@enabled`).run(next);
}

// -- habits ---------------------------------------------------------------------------
export function addHabit(text, intervalMin, nextAt) {
  return getDb().prepare('INSERT INTO habits (text,interval_min,next_at) VALUES (?,?,?)')
    .run(text, intervalMin, nextAt).lastInsertRowid;
}
export function listHabits() {
  return getDb().prepare('SELECT * FROM habits ORDER BY id').all();
}
export function removeHabit(id) {
  return getDb().prepare('DELETE FROM habits WHERE id=?').run(id).changes;
}
export function dueHabits(now) {
  return getDb().prepare('SELECT * FROM habits WHERE enabled=1 AND next_at<=?').all(now);
}
export function bumpHabit(id, nextAt) {
  getDb().prepare('UPDATE habits SET next_at=? WHERE id=?').run(nextAt, id);
}

// -- busy auto-reply --------------------------------------------------------------
export function busyAlreadyReplied(jid) {
  return !!getDb().prepare('SELECT 1 FROM busy_replied WHERE jid=?').get(jid);
}
export function markBusyReplied(jid) {
  getDb().prepare('INSERT OR REPLACE INTO busy_replied (jid,ts) VALUES (?,?)').run(jid, Date.now());
}
export function clearBusyReplied() {
  getDb().prepare('DELETE FROM busy_replied').run();
}

// -- group message stats -----------------------------------------------------------
export function bumpStat(chatId, userId, hour) {
  const db = getDb();
  const row = db.prepare('SELECT hours FROM msg_stats WHERE chat_id=? AND user_id=?').get(chatId, userId);
  let hours = {};
  if (row) { try { hours = JSON.parse(row.hours); } catch { hours = {}; } }
  hours[hour] = (hours[hour] || 0) + 1;
  const now = Date.now();
  // first_ts is set only on INSERT (left untouched on conflict) so it marks when
  // this member was first seen — i.e. where our data for them begins.
  db.prepare(`INSERT INTO msg_stats (chat_id,user_id,count,hours,last_ts,first_ts) VALUES (?,?,1,?,?,?)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET count=count+1, hours=excluded.hours, last_ts=excluded.last_ts`)
    .run(chatId, userId, JSON.stringify(hours), now, now);
}
export function topStats(chatId, n = 10) {
  return getDb().prepare('SELECT * FROM msg_stats WHERE chat_id=? ORDER BY count DESC LIMIT ?').all(chatId, n);
}
// Members active since a cutoff (ms epoch; 0 = all time), most recent first.
export function activeSince(chatId, sinceTs = 0) {
  return getDb().prepare('SELECT user_id, count, last_ts FROM msg_stats WHERE chat_id=? AND last_ts>=? ORDER BY last_ts DESC').all(chatId, sinceTs);
}
// Earliest point we have data for in this chat (min first_ts); null if unknown
// (e.g. rows recorded before the first_ts column existed).
export function statsTrackingSince(chatId) {
  const r = getDb().prepare('SELECT MIN(first_ts) AS since FROM msg_stats WHERE chat_id=?').get(chatId);
  return r?.since || null;
}
export function chatHourHistogram(chatId) {
  const rows = getDb().prepare('SELECT hours FROM msg_stats WHERE chat_id=?').all(chatId);
  const total = {};
  for (const r of rows) {
    try {
      const h = JSON.parse(r.hours);
      for (const [k, v] of Object.entries(h)) total[k] = (total[k] || 0) + v;
    } catch { /* skip bad row */ }
  }
  return total;
}

// -- tracked anime -----------------------------------------------------------------
export function addTrackedAnime(title, malId = null, broadcast = null, nextAirAt = null) {
  return getDb().prepare('INSERT INTO tracked_anime (title, mal_id, broadcast, next_air_at) VALUES (?,?,?,?)')
    .run(title, malId, broadcast, nextAirAt).lastInsertRowid;
}
export function listTrackedAnime() {
  return getDb().prepare('SELECT * FROM tracked_anime ORDER BY id').all();
}
export function removeTrackedAnime(id) {
  return getDb().prepare('DELETE FROM tracked_anime WHERE id=?').run(id).changes;
}
export function dueAnime(now) {
  return getDb().prepare('SELECT * FROM tracked_anime WHERE next_air_at IS NOT NULL AND next_air_at <= ?').all(now);
}
export function bumpAnimeNext(id, nextAirAt) {
  getDb().prepare('UPDATE tracked_anime SET next_air_at=? WHERE id=?').run(nextAirAt, id);
}

// -- cooldowns (Pokemon pattern) -----------------------------------------------------
export function getCooldown(userId, action) {
  return getDb().prepare('SELECT * FROM cooldowns WHERE user_id=? AND action=?').get(userId, action);
}
export function setCooldown(userId, action) {
  getDb().prepare(`INSERT INTO cooldowns (user_id,action,last_used_at) VALUES (?,?,?)
    ON CONFLICT(user_id,action) DO UPDATE SET last_used_at=excluded.last_used_at`)
    .run(userId, action, Date.now());
}

// ════════════════════════ utility module ════════════════════════

// -- pins ----------------------------------------------------------------------------
export function addPin(row) {
  return getDb().prepare(`INSERT INTO pins (tag,sender,push_name,chat_id,type,content,media_path,ts)
    VALUES (@tag,@sender,@push_name,@chat_id,@type,@content,@media_path,@ts)`).run(row).lastInsertRowid;
}
export function listPins(tag = null) {
  return tag
    ? getDb().prepare('SELECT * FROM pins WHERE tag=? ORDER BY ts DESC').all(tag.toLowerCase())
    : getDb().prepare('SELECT * FROM pins ORDER BY ts DESC').all();
}
export function getPin(id) {
  return getDb().prepare('SELECT * FROM pins WHERE id=?').get(id);
}
export function deletePin(id) {
  return getDb().prepare('DELETE FROM pins WHERE id=?').run(id).changes;
}
export function searchPins(keyword) {
  return getDb().prepare("SELECT * FROM pins WHERE content LIKE ? ESCAPE '\\' ORDER BY ts DESC").all(`%${likeEscape(keyword)}%`);
}

// -- todos ---------------------------------------------------------------------------
export function addTodo(task, priority = 0) {
  return getDb().prepare('INSERT INTO todos (task,priority,ts) VALUES (?,?,?)').run(task, priority, Date.now()).lastInsertRowid;
}
export function listTodos(includeDone = false) {
  return includeDone
    ? getDb().prepare('SELECT * FROM todos ORDER BY done, priority DESC, id').all()
    : getDb().prepare('SELECT * FROM todos WHERE done=0 ORDER BY priority DESC, id').all();
}
export function markTodoDone(id) {
  return getDb().prepare('UPDATE todos SET done=1 WHERE id=? AND done=0').run(id).changes;
}
export function deleteTodo(id) {
  return getDb().prepare('DELETE FROM todos WHERE id=?').run(id).changes;
}
export function clearDoneTodos() {
  return getDb().prepare('DELETE FROM todos WHERE done=1').run().changes;
}

// -- pomodoro (single row, id=1) ------------------------------------------------------
export function getPomo() {
  return getDb().prepare('SELECT * FROM pomodoro WHERE id=1').get();
}
export function startPomo(workMin, breakMin, cycles) {
  getDb().prepare(`INSERT INTO pomodoro (id,work_min,break_min,cycles,cycle,phase,phase_ends_at,active)
    VALUES (1,@w,@b,@c,1,'work',@ends,1)
    ON CONFLICT(id) DO UPDATE SET work_min=@w, break_min=@b, cycles=@c, cycle=1, phase='work', phase_ends_at=@ends, active=1`)
    .run({ w: workMin, b: breakMin, c: cycles, ends: Date.now() + workMin * 60000 });
}
export function updatePomo(patch) {
  const cur = getPomo();
  if (!cur) return;
  const next = { ...cur, ...patch };
  // bind exact columns positionally — extra named params throw on some
  // better-sqlite3 versions (the host runs v12, local dev v9)
  getDb().prepare('UPDATE pomodoro SET cycle=?, phase=?, phase_ends_at=?, active=? WHERE id=1')
    .run(next.cycle, next.phase, next.phase_ends_at, next.active);
}
export function stopPomo() {
  return getDb().prepare('UPDATE pomodoro SET active=0 WHERE id=1 AND active=1').run().changes;
}

// -- recurring reminders --------------------------------------------------------------
export function addRecurring(schedule, label, text, nextAt) {
  return getDb().prepare('INSERT INTO recurring (schedule,label,text,next_at) VALUES (?,?,?,?)')
    .run(JSON.stringify(schedule), label, text, nextAt).lastInsertRowid;
}
export function listRecurring() {
  return getDb().prepare('SELECT * FROM recurring WHERE active=1 ORDER BY id').all();
}
export function dueRecurring(now) {
  return getDb().prepare('SELECT * FROM recurring WHERE active=1 AND next_at<=?').all(now);
}
export function bumpRecurring(id, nextAt) {
  getDb().prepare('UPDATE recurring SET next_at=? WHERE id=?').run(nextAt, id);
}
export function cancelRecurring(id) {
  return getDb().prepare('UPDATE recurring SET active=0 WHERE id=? AND active=1').run(id).changes;
}

// -- ideas ----------------------------------------------------------------------------
export function addIdea(text) {
  return getDb().prepare('INSERT INTO ideas (text,ts) VALUES (?,?)').run(text, Date.now()).lastInsertRowid;
}
export function listIdeas() {
  return getDb().prepare('SELECT * FROM ideas ORDER BY ts DESC').all();
}
export function deleteIdea(id) {
  return getDb().prepare('DELETE FROM ideas WHERE id=?').run(id).changes;
}
export function searchIdeas(keyword) {
  return getDb().prepare("SELECT * FROM ideas WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC").all(`%${likeEscape(keyword)}%`);
}

// -- read later -------------------------------------------------------------------------
export function addReadLater(url, note) {
  return getDb().prepare('INSERT INTO readlater (url,note,ts) VALUES (?,?,?)').run(url, note, Date.now()).lastInsertRowid;
}
export function listReadLater(unreadOnly = false) {
  return unreadOnly
    ? getDb().prepare('SELECT * FROM readlater WHERE read=0 ORDER BY ts DESC').all()
    : getDb().prepare('SELECT * FROM readlater ORDER BY read, ts DESC').all();
}
export function getReadLater(id) {
  return getDb().prepare('SELECT * FROM readlater WHERE id=?').get(id);
}
export function markRead(id) {
  return getDb().prepare('UPDATE readlater SET read=1 WHERE id=? AND read=0').run(id).changes;
}
export function deleteReadLater(id) {
  return getDb().prepare('DELETE FROM readlater WHERE id=?').run(id).changes;
}

// -- uptime monitors ---------------------------------------------------------------------
export function addMonitor(url, name) {
  return getDb().prepare('INSERT INTO monitors (url,name) VALUES (?,?)').run(url, name).lastInsertRowid;
}
export function listMonitors() {
  return getDb().prepare('SELECT * FROM monitors ORDER BY id').all();
}
export function deleteMonitor(id) {
  return getDb().prepare('DELETE FROM monitors WHERE id=?').run(id).changes;
}
export function updateMonitor(id, status, detail, changed) {
  const now = Date.now();
  if (changed) {
    getDb().prepare('UPDATE monitors SET last_status=?, last_detail=?, last_checked=?, last_change=? WHERE id=?')
      .run(status, detail, now, now, id);
  } else {
    getDb().prepare('UPDATE monitors SET last_status=?, last_detail=?, last_checked=? WHERE id=?')
      .run(status, detail, now, id);
  }
}

// -- birthdays -----------------------------------------------------------------------------
export function addBirthday(name, day, month, year) {
  return getDb().prepare('INSERT INTO birthdays (name,day,month,year) VALUES (?,?,?,?)')
    .run(name, day, month, year).lastInsertRowid;
}
export function listBirthdays() {
  return getDb().prepare('SELECT * FROM birthdays ORDER BY month, day').all();
}
export function deleteBirthdayByName(name) {
  return getDb().prepare('DELETE FROM birthdays WHERE LOWER(name)=LOWER(?)').run(name).changes;
}
export function findBirthday(name) {
  return getDb().prepare('SELECT * FROM birthdays WHERE LOWER(name) LIKE LOWER(?)').get(`%${name}%`);
}
export function setBirthdayDayBefore(id, on) {
  getDb().prepare('UPDATE birthdays SET notify_day_before=? WHERE id=?').run(on ? 1 : 0, id);
}

// -- NEXUS assistant (chat history + durable memory) ---------------------------
export function addNexusTurn(role, content) {
  return getDb().prepare('INSERT INTO nexus_history (role,content,ts) VALUES (?,?,?)')
    .run(role, content, Date.now()).lastInsertRowid;
}
export function recentNexusTurns(limit = 20) {
  return getDb().prepare('SELECT role, content FROM nexus_history ORDER BY id DESC LIMIT ?').all(limit).reverse();
}
export function trimNexusHistory(keep = 200) {
  getDb().prepare('DELETE FROM nexus_history WHERE id NOT IN (SELECT id FROM nexus_history ORDER BY id DESC LIMIT ?)').run(keep);
}
export function clearNexusHistory() {
  return getDb().prepare('DELETE FROM nexus_history').run().changes;
}
export function addNexusMemory(fact) {
  return getDb().prepare('INSERT INTO nexus_memory (fact,ts) VALUES (?,?)').run(fact, Date.now()).lastInsertRowid;
}
export function listNexusMemory() {
  return getDb().prepare('SELECT * FROM nexus_memory ORDER BY id').all();
}
export function deleteNexusMemory(id) {
  return getDb().prepare('DELETE FROM nexus_memory WHERE id=?').run(id).changes;
}
export function clearNexusMemory() {
  return getDb().prepare('DELETE FROM nexus_memory').run().changes;
}
