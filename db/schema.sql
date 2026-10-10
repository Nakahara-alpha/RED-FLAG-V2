-- 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 schema
CREATE TABLE IF NOT EXISTS config (
  chat_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS antiword (
  chat_id TEXT NOT NULL,
  word    TEXT NOT NULL,
  PRIMARY KEY (chat_id, word)
);

CREATE TABLE IF NOT EXISTS antilink_whitelist (
  chat_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  PRIMARY KEY (chat_id, pattern)
);

CREATE TABLE IF NOT EXISTS link_strikes (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  keyword TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS msg_cache (
  msg_id     TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  sender     TEXT,
  push_name  TEXT,
  type       TEXT,
  content    TEXT,
  media_path TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_cache_ts   ON msg_cache(ts);
CREATE INDEX IF NOT EXISTS idx_msg_cache_chat ON msg_cache(chat_id, ts);

CREATE TABLE IF NOT EXISTS scheduled (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  run_at     INTEGER NOT NULL,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at     INTEGER NOT NULL,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timetable (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  day      INTEGER NOT NULL,           -- 1=Mon .. 7=Sun
  start    TEXT NOT NULL,              -- HH:MM
  end      TEXT NOT NULL,
  course   TEXT NOT NULL,
  location TEXT
);

CREATE TABLE IF NOT EXISTS deadlines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  course       TEXT NOT NULL,
  task         TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  reminded_24h INTEGER NOT NULL DEFAULT 0,
  reminded_2h  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  tag  TEXT NOT NULL,
  text TEXT NOT NULL,
  ts   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exams (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  course  TEXT NOT NULL,
  exam_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gpa_history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  semester TEXT,
  gpa      REAL NOT NULL,
  units    INTEGER NOT NULL,
  points   REAL NOT NULL,
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  amount   REAL NOT NULL,
  category TEXT NOT NULL,
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warns (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS welcome (
  chat_id    TEXT PRIMARY KEY,
  join_text  TEXT,
  leave_text TEXT,
  enabled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS habits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,
  interval_min INTEGER NOT NULL,
  next_at      INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS busy_replied (
  jid TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS msg_stats (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  hours   TEXT NOT NULL DEFAULT '{}',
  last_ts INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS tracked_anime (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, action)
);

-- ── utility module ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tag        TEXT,
  sender     TEXT,
  push_name  TEXT,
  chat_id    TEXT,
  type       TEXT,
  content    TEXT,
  media_path TEXT,
  ts         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task     TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  done     INTEGER NOT NULL DEFAULT 0,
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pomodoro (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- single active pomo (DECISIONS.md)
  work_min      INTEGER NOT NULL,
  break_min     INTEGER NOT NULL,
  cycles        INTEGER NOT NULL,
  cycle         INTEGER NOT NULL DEFAULT 1,
  phase         TEXT NOT NULL DEFAULT 'work',
  phase_ends_at INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recurring (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule TEXT NOT NULL,          -- JSON: {type:'interval'|'daily'|'weekly', ...}
  label    TEXT NOT NULL,          -- human-readable schedule
  text     TEXT NOT NULL,
  next_at  INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ideas (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  ts   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readlater (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  url  TEXT NOT NULL,
  note TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  ts   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL,
  name         TEXT,
  last_status  TEXT,               -- 'up' | 'down' | NULL = never checked
  last_detail  TEXT,
  last_checked INTEGER,
  last_change  INTEGER
);

CREATE TABLE IF NOT EXISTS birthdays (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  day               INTEGER NOT NULL,
  month             INTEGER NOT NULL,
  year              INTEGER,
  notify_day_before INTEGER NOT NULL DEFAULT 1
);

-- ── NEXUS (conversational assistant: rolling chat history + durable memory) ──
CREATE TABLE IF NOT EXISTS nexus_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,            -- 'user' | 'assistant'
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nexus_memory (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  fact TEXT NOT NULL,
  ts   INTEGER NOT NULL
);
