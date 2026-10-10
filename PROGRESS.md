# 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 — Progress

## Status: ALL 7 PHASES BUILT ✅ (awaiting live pairing test)

### Step 0 — Recon ✅
- Read Mellow-MD core (index.js, commandHandler.js) and the Pokemon plugin end-to-end.
- Matched: socket boot + reconnect, better-sqlite3/WAL/migrations, command-map router, owner gating, friendly-error pattern.
- Pivot mid-build (user): standalone bot in `Downloads/RED-FLAG-V2`, **not** a Mellow plugin. Plugin stubs removed from Mellow.

### Phase 1 — Foundation + passive protection ✅
- SQLite schema (18 tables), queries layer, per-chat config toggles, 20s scheduler.
- Anti-delete (text + image/video/audio/sticker/document, resent to owner with who/where/when), view-once auto-save, antiword (per-group list, delete+warn+kick at limit), antilink (delete → warn → kick, whitelist), keyword alerts → owner DM.

### Phase 2 — Chat tools ✅
- `!busy` one-shot auto-reply per contact, `!schedule/scheduled/unschedule`, `!remind` + `!remindme` (reply), `!export <n> [json]`, `!autoread` per chat.

### Phase 3 — AI ✅
- `!ai`, `!summarize <n>` (from cache), `!tldr` (link/text/PDF), `!tr`, `!draft`, `!ocr`, `!transcribe`. Groq→Gemini fallback throughout.

### Phase 4 — Uni ✅
- `!tt` timetable + `!today`/`!next` (with countdown), `!due` (auto 24h/2h reminders), `!gpa` (5.0 scale + saved history + CGPA), `!note/!notes`, `!exam` + `!countdown`, `!pq` (local PDF folder).

### Phase 5 — IoT ✅
- `!led/!room/!esp` (MQTT bridge, lazy `mqtt` import), `!pc lock/shutdown(confirm)/screenshot/status`, `!nexus` relay (graceful offline), `!status` (uptime/RAM/disk >85% flag).

### Phase 6 — Daily + utility + stickers + downloads ✅
- Daily digest 06:30 (classes/deadlines/weather/anime), `!spent/!expenses`, `!habit`, `!airing` + `!track`, `!sticker/!toimg`, `!qr` (make+read), `!usd/!fx`, `!calc`, `!conv`, `!short`, `!weather`, `!define`, `!wiki`, `!yt/!tiktok/!ig/!x/!compress`.

### Phase 7 — Group admin ✅
- `!everyone`, `!tagnotadmin`, `!warn/!warns/!resetwarn` (3-warn kick), `!welcome/!goodbye` ({user}/{group} templates), `!stats` (top members + peak hour), `!poll`. Gated to group admins or owner; kick/delete only when the bot is actually admin.

### Verified
- 2026-07-05 smoke test: all modules load, 68 commands registered, DB + sharp + stickers-formatter working, WAT time parsing correct.

## Utility Module (2026-07-06) — ALL 14 FEATURES BUILT ✅ (no AI, all deterministic)

1. **Pin-to-self** ✅ — `!pin [tag]` (reply), `!pins [tag] [page]`, `!pin get <id>`, `!unpin`, `!findpin`; media saved to data/pins/ and re-sent on retrieval.
2. **Edit tracker** ✅ — MESSAGE_EDIT protocol events → owner DM with original + edited text (original from msg_cache); `!edittrack on/off` per chat.
3. **Ghost mode** ✅ — `!ghost on/off` per chat, `!ghost global on/off` default, `!ghost clear`; README note about the real app still sending receipts.
4. **To-do** ✅ — `!todo add [!high]/done/del/clear`, priority-sorted list.
5. **Pomodoro** ✅ — `!pomo [w] [b] [cycles]`, stop/status; phase changes DM'd via scheduler; single session.
6. **Recurring reminders** ✅ — `!every 1h|day 9pm|monday 8am <text>`, `!recurring`, `!every stop <id>`.
7. **Quick capture** ✅ — `!idea <text>` → "✓ #id", `!ideas [page|keyword]`, `!idea del`.
8. **Read-later** ✅ — `!later <url> [note]` (auto-detects URL in replies), `!readlist [unread]`, `!read/!readdone/!readdel <id>`.
9. **Meme maker** ✅ — `!meme top | bottom` on replied image/static sticker; sharp SVG Impact-style overlay; render visually verified.
10. **Quote cards** ✅ — `!quote [dark|light] [sticker] <text>` or reply (attribution from cache); both styles visually verified.
11. **QR** ✅ — `!qr` (generate) existed; `!qrread` (decode replied image) added.
12. **Uptime monitor** ✅ — `!monitor add/del/check/list`; 5-min scheduler pings; DM on up↔down transitions.
13. **Birthdays** ✅ — `!bday add <name> <DD-MM[-YYYY]>`, list sorted by nearest, `!bday <name>` days-until + age, daily 08:00 check with day-before reminders (toggleable).
14. **View-once openers** ✅ — `!vv` (re-send to current chat), `!pvv` (send to owner DM); image/video/voice, captions preserved.

Smoke-tested 2026-07-06: 91 commands, all new queries pass, meme + both quote styles rendered correctly.

## Hardening pass (2026-07-06) — ALL 10 FIXES DONE ✅ (+ !ping, new !menu/!help)

1. ✅ Scheduler rehydration — boot log, missed-note on late one-shots, silent roll-forward for recurring, offline-pomodoro closure.
2. ✅ WAT timezone — `wat()` helper everywhere, `TZ_OFFSET_MIN` config, verified under a UTC server.
3. ✅ Passive gating — in-memory config cache (no DB per message); antidelete/viewonce/edittrack/alerts now per-chat opt-in, default OFF.
4. ✅ Media cleanup — 15-min retention, 500 MB cap + owner warning, generated images never touch disk, pins exempt.
5. ✅ Admin precheck — antilink/antiword announce missing admin once per chat instead of silent no-op.
6. ✅ Owner list — already comma-separated OWNER_NUMBER (pokebot-style config-number check) + fromMe.
7. ✅ Kill switch — `!panic` / `!panic off` (alias `!silent`), persists across restarts.
8. ✅ Debounce — monitor transitions only + 10-min cooldown; keyword alerts 5-min per keyword per chat.
9. ✅ Backup — `!backup` to owner DM + nightly 02:00 WAT auto-backup, keeps 7.
10. ✅ Prefix conflict — none: this bot uses `!`, Mellow/Pokemon/Naruto use `.`. Logged.

Also: `!ping`, and a rebuilt boxed `!menu` + `!help <command>` driven by one source-of-truth map, with optional banner at `data/menu-banner.jpg` (text fallback). 94 commands total, all smoke-tested.

### To do (owner)
1. Fill `OWNER_NUMBER`, `GROQ_API_KEY`/`GEMINI_API_KEY` in config.env.
2. Drop your menu picture at `data/menu-banner.jpg` (optional).
3. `npm start` → scan QR (Linked devices).
4. Turn protection on where you want it: `!antidelete on`, `!viewonce on`, `!edittrack on` per chat.
5. Optional: `npm i mqtt` for ESP32; install ffmpeg for video stickers/`!compress`; set `PQ_DIR`.
