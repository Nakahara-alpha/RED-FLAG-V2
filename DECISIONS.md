# 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 — Decisions Log

## Big pivots (user-directed)
- **Name**: 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2 ("just red flag", no "BY").
- **Standalone bot, not a plugin** — lives at `Downloads/RED-FLAG-V2`, its own process, its own WhatsApp session (QR pairing), its own SQLite DB. This is the strongest form of the spec's isolation rule: a crash here can never touch Mellow/Pokemon/Naruto.
- Architecture *patterns* still mirror the Mellow/Pokemon bot (studied end-to-end first): Baileys socket boot with identical reconnect logic, better-sqlite3 + WAL + idempotent migrations array, command-map router, passive `onMessage`-style pipeline, friendly errors + console logging.

## Runtime
- **Prefix**: `!` by default (spec's `!command` style; also avoids colliding with Mellow's `.` if both run on one account). Change via `PREFIX` in config.env.
- **Owner gate**: owner = `msg.key.fromMe` (bot runs on the owner's account) OR sender number ∈ `OWNER_NUMBER` env (Pokemon's isOwner pattern). Every command is owner-only except Phase-7 group tools (`adminOnly: true` → group admins or owner). Non-owners are ignored silently.
- **Pairing**: `useMultiFileAuthState('./session')` + QR in terminal (qrcode-terminal). No dependence on Mellow's SESSION_ID server.
- **node_modules**: NTFS junction → `../Mellow-MD-master/node_modules` (all deps are a subset and it's instant). `package.json` lists real deps, so `npm i` in this folder makes it fully independent whenever wanted.
- **Isolation inside the bot**: every passive handler and every command is try/catch-wrapped; init failures log instead of crashing; media caching is fire-and-forget so the message pipeline never blocks.

## Storage
- One DB: `db/redflag.db` (WAL). Schema `db/schema.sql`; migrations array in `db/queries.js` for future ALTERs. Multi-row writes use `db.transaction()` (see `clearMediaPaths`).
- **Anti-delete retention**: text rows **7 days** (also powers `!export` + `!summarize`), media files **10 min** (spec default) in `data/media/`, hard cap **100 MB** (oldest deleted first). Cleanup on the scheduler tick. Media over 16 MB is not cached.

## Provider choices (PAUSE-AND-LOG items)
- **AI chat**: Groq `llama-3.3-70b-versatile` primary → Gemini `gemini-2.0-flash` fallback. Keys from `GROQ_API_KEY`/`GEMINI_API_KEY` env only; commands degrade with a friendly setup hint if unset.
- **Speech-to-text**: Groq Whisper `whisper-large-v3-turbo` (same key, fast, free tier).
- **OCR**: Gemini vision primary, Groq Llama-4-Scout vision fallback (no native tesseract dep).
- **PDF tldr**: Gemini inline PDF (no pdf-parse dep).
- **Downloaders**: `ruhend-scraper` (installed) — ttdl (TikTok no-watermark), igdl, ytmp3/ytmp4. **X/Twitter** via api.vxtwitter.com (no installed lib covers X). `!compress` uses ffmpeg from PATH (friendly error if missing).
- **Stickers**: `stickers-formatter` (image + video; video needs ffmpeg). `!toimg` via sharp. Animated stickers → first frame (reliable without ffmpeg).
- **QR**: api.qrserver.com create/read. **FX**: open.er-api.com. **Weather**: wttr.in JSON. **Dictionary**: dictionaryapi.dev. **Wiki**: Wikipedia REST. **Short**: tinyurl. **Anime**: AniList GraphQL (richer + higher-limit than Jikan; exact next-episode times). **News**: Google News RSS. **AI**: Gemini (multi-key, primary) → AgentRouter (OpenAI-compatible; powers NEXUS tool-calling) → Groq.
- **MQTT**: `mqtt` package optional + lazy-imported; friendly "npm i mqtt" message if absent. Env: `MQTT_URL/USERNAME/PASSWORD/TOPIC_PREFIX` (default prefix `redflag`; `!esp` publishes `redflag/<topic>`, replies expected on `<topic>/reply`).
- **PC remote**: Windows-first (LockWorkStation / `shutdown /s /t 30` / PowerShell CopyFromScreen screenshot). Shutdown needs `!pc confirm` within 30s. Non-Windows → friendly unsupported message (lock/screenshot).
- **GPA**: 5.0 scale A=5 B=4 C=3 D=2 E=1 F=0 (standard Nigerian scale). CGPA = Σpoints/Σunits over saved semesters.
- **Daily digest**: default **06:30**, `digest_last` date guard set *before* sending so a crash can't spam. Weather city default Lagos. Times are server-local (owner's machine, WAT).
- **Habit schedule**: fixed interval (`!habit add 90m drink water`); after a missed window it reschedules from *now* to avoid burst-firing.

## Conflicts with spec (logged per instructions)
- `!schedule <time> <chat> <message>` → `!schedule <when> | <message>` targeting the **current chat** (no safe way to resolve arbitrary chat names to JIDs).
- `!export` depends on the bot's own 7-day cache (Baileys can't fetch arbitrary history on demand).
- Antilink/antiword stay silent when the bot lacks group-admin rights (can't delete/kick), rather than spamming warnings it can't enforce; `!antilink on` reminds the owner admin is needed.
- Node engines relaxed to >=20 (machine runs v20.19.5; everything tested fine).

## Verified by smoke test (2026-07-05)
Module graph loads (68 commands registered), DB schema + all query helpers work, sharp native binding OK, stickers-formatter OK, time parsing correct in WAT.

---

# Utility Module (2026-07-06) — no AI, all local/deterministic

## Architecture
- Built into the standalone bot (the "same as Pokemon plugin" instruction is superseded by the user's earlier standalone-bot pivot; existing architecture wins). Same registry pattern: 6 new command modules registered in `lib/handler.js`, protocol-event routing extended for edits, new scheduler jobs on the existing 20s tick.
- **Edit tracker reuses `msg_cache`** instead of the spec's separate `edit_cache` table — cacheIncoming already stores every message with 7-day text retention (≫ the 15-min spec default, so originals are almost always available). On MESSAGE_EDIT (protocolMessage type 14) the original is read from cache, the owner is DM'd before/after, and the cache row is updated so a second edit diffs correctly. Toggle `!edittrack on/off` per chat, default ON.
- **Ghost mode**: WhatsApp bots only emit read receipts when they call `readMessages`, so ghost is implemented as "don't auto-read" (ON, the default) vs "auto-read handled messages" (OFF). Per-chat `!ghost on/off` overrides the `!ghost global` default. README notes the app itself still sends receipts when a chat is opened manually.
- **Pins media** goes to `data/pins/` (kept forever, deleted only on `!unpin`) — deliberately outside the anti-delete cache dir so retention purges can't eat pins.

## Defaults chosen (PAUSE-AND-LOG)
- **Pre-edit cache retention**: rides msg_cache's 7 days (text) — richer than the 15-min spec default at trivial cost. View-once/anti-delete media stays at 10 min + 100 MB cap as before.
- **Pomodoro**: single active session (spec-sanctioned); defaults 25/5 × 4 cycles; last work phase ends the session (no trailing break). Limits 180m/60m/12 cycles.
- **Recurring reminders**: three schedule shapes — `1h` interval (min 5m), `day 9pm` daily, `monday 8am` weekly. Stored as JSON + precomputed `next_at`; after firing, next occurrence is computed from *now* (no burst catch-up). A corrupt schedule row gets pushed +24h instead of spinning.
- **Meme font**: SVG `Impact, 'Arial Black', sans-serif` stack with `paint-order:stroke` black outline (Windows ships Impact; no font files bundled). Max 4 lines per block, auto-sized to image width. Animated stickers → first frame.
- **Quote card styles**: `dark` (charcoal gradient, red accent — default) and `light` (cream, gold accent), 1080×1080, serif type, auto font-size by text length (64→34px), attribution from msg_cache push_name when replying. `sticker` flag renders 512×512 webp.
- **Monitor ping interval**: 5 min, GET with 10s timeout, up = HTTP < 400. Alerts only on status *transitions* (plus a first check that comes back down). `!monitor check` forces all.
- **Birthdays**: day-before reminder ON by default (per-entry `!bday daybefore <name> off`). Daily check fires once after 08:00, guarded by a `bday_last` date key set before sending (crash can't spam).
- **QR**: `!qrread` added as a dedicated reader; generation/reading still via api.qrserver.com (only non-AI external API in the module, per the QR feature's nature).

## Verified by smoke test (2026-07-06)
91 commands registered (+23). All new tables + queries pass (pins/todos/pomodoro/recurring/ideas/readlater/monitors/birthdays), weekly/daily nextOccurrence correct, clock parsing (9pm/8:30am) correct, pagination correct, meme overlay and both quote-card styles rendered and visually checked.

---

# Hardening pass (2026-07-06) — retrofits, no rewrites

1. **Scheduler rehydration**: the design was already restart-safe (everything DB-backed with absolute `run_at` epochs, polled by the 20s tick — zero in-memory setTimeouts). Added on top: boot `rehydrate()` with "Rehydrated N scheduled items" log; one-shots >10 min late get a "_(missed while offline)_" note; daily/weekly recurring >60 min late roll forward **silently** (intervals just resume — never a burst); an active pomodoro whose whole phase window expired offline is closed with a DM note (queued until the socket connects), otherwise it resumes naturally. Deadline 24h/2h flags were already in DB; digest/birthday/backup use date-key guards set *before* sending so a crash can't double-fire.
2. **Timezone**: single source `TZ_OFFSET_MIN` env (default 60 = Africa/Lagos, no DST). New `wat()` helper (dayjs utc + fixed offset) replaces every `dayjs()` parse/format/weekday call across helpers, scheduler, uni, daily, productivity, trackers, group-admin (stats hour too). DB stays absolute UTC epochs. Verified by running the suite with `TZ=UTC`: `18:30` parses to 18:30+01:00.
3. **Passive gating**: all `config` reads now go through an in-memory Map loaded once from DB (writes update DB then cache) — zero DB hits per message for toggles. Anti-delete media capture, revoke reports, view-once saves, edit tracking, and keyword alerts are now **per-chat opt-in, default OFF** (`!antidelete on`, `!viewonce on`, `!edittrack on`, `!alert on`). Nuance kept: plain **text caching stays global** (one cheap synchronous insert) because `!export`, `!summarize`, quote attribution, and edit-tracker originals depend on it — logged as a deliberate deviation. Media work was already fire-and-forget.
4. **Media cleanup**: ephemeral retention now **15 min** (`MEDIA_RETENTION_MIN`), cap **500 MB** (`MEDIA_CAP_MB`) with oldest-first eviction + a once-per-day owner warning when the cap trips. Meme/quote/QR were already buffer-only (never touch disk); pins are intentionally exempt (user-saved, deleted on `!unpin`); `!status` already flags disk >85%.
5. **Admin precheck**: antilink/antiword now post one "⚠️ I need admin rights" notice per chat per boot when unenforceable (previously silent); warn-kick already messaged; tagall/mentions/welcome don't need admin.
6. **Owner list**: already multi-JID — comma-separated `OWNER_NUMBER` (same config-number check as the pokebot) + `fromMe` + LID match. No change needed.
7. **Kill switch**: `!panic` / `!panic off` (alias `!silent`) — one cached global flag short-circuits the entire passive pipeline (incl. protocol events, welcome, busy, stats). Persists in config across restarts; confirmation lists exactly what's off.
8. **Debounce**: monitors alert on transitions only + 10-min per-monitor re-alert cooldown (flap protection); keyword alerts max once per keyword per chat per 5 min.
9. **Backup**: `!backup` → `better-sqlite3 .backup()` (WAL-consistent) to `data/backups/redflag-<WAT timestamp>.db`, sent to owner DM. Nightly auto-backup at 02:00 WAT, keeps last 7.
10. **Conflict check**: this bot is a separate process with prefix `!`; Mellow/Pokemon/Naruto use `.` (`.p`/`.n` routers). Even sharing one WhatsApp account there is no command-space overlap (`!menu`/`!help`/`!status` vs `.menu`/`.p menu`). Resolution: keep distinct prefixes; nothing namespaced.

Extras: `!ping` (latency + uptime). Menu rebuilt: boxed sections generated from a single SECTIONS source-of-truth (name/usage/desc/example/aliases) that also powers `!help <command>` (alias-aware); banner image at `data/menu-banner.jpg` with clean text fallback (Pokemon-menu approach).

Verified (2026-07-06, second pass): 94 commands; WAT correct under TZ=UTC; config cache; "Rehydrated 2 scheduled items"; backup file created; menu falls back to text without banner; `!help pomo` and alias lookup (`ttdl`→tiktok) working.

## Prefix (2026-07-06, user decision)
Default prefix changed `!` → `.` per user. Now resolved at runtime: DB config (`prefix` key, set via the `prefix <symbol>` command — persists across restarts) → `PREFIX` env → `.`. Validation: 1–3 symbols, no letters/digits/spaces. Every usage string already calls `PREFIX()` dynamically, so menus/help update instantly. Collision note: Mellow only registers top-level `.p`/`.n` plugin words, and this bot has no `p`/`n` commands, so `.` is safe even on a shared account.

## Hosting on OptikLink + login-loop fix (2026-07-06)
- **Node 25 / better-sqlite3**: OptikLink's container runs Node v25.9.0, which has no `better-sqlite3@9` prebuilt binary and fails the source build (Node 25 headers need C++20). Bumped to `better-sqlite3@^12.4.1` (installs 12.11.1, has a Node-25 prebuild) — resolved. sharp 0.33.5 builds fine there.
- **"Logged out" pairing loop (fixed)**: two bugs. (1) The pairing code was requested from a `startBot`-local flag that reset on every reconnect, so the post-pair `restartRequired` (515) reconnect requested a *second* code and invalidated the session — moved the guard to a module-level `pairingCodeShown` (once per process). (2) The socket used a non-canonical auth block (`auth: state` + redundant top-level `creds`/`keys`), so it authenticated with raw `state.keys` while the cacheable wrapper was discarded — what got persisted diverged from what authenticated, giving a 401 on the next connect. Fixed to the canonical `auth: { creds, keys: makeCacheableSignalKeyStore(...) }` plus a stable `browser` signature. On a genuine `loggedOut`, the session folder is now wiped and re-paired automatically (fresh code) instead of dead-ending.

## Public group access + play (2026-07-06)
- **Public mode**: `.public on/off` per group lets non-owner members run a curated safe set (`lib/access.js` `PUBLIC_COMMANDS`): play, meme, quote, sticker, toimg, qr/qrread, yt/tiktok/ig/x, ai, tr, calc, conv, usd, fx, weather, define, wiki, short, airing, ping. Everything else stays owner/admin-only. DMs remain owner-only regardless. 5s per-user cooldown guards spam.
- **Blocklist**: `.block <cmd>` / `.unblock <cmd>` / `.blocked` (admin/owner) removes specific commands from what members can use, stored per-group in `config.public_block`. Only public-set commands are blockable (others are never public anyway). `PUBLIC_COMMANDS` lives in its own module so handler + access commands share it without an import cycle.
- **`.play <song|link>`** (aliases song/music, public): `ruhend-scraper` `ytsearch` → first result → `ytmp3` → sends audio. Friendly failure, never throws.

## Post-launch fixes (2026-07-06/07, live on OptikLink)
- **getMessage retries**: DB text fallback removed — reconstructing `{conversation}` for what was really an `extendedTextMessage` mismatches the retry and produces empty "waiting" bubbles. Retries are now answered ONLY with the exact stored proto (send-time capture via a sendMessage wrapper + in-memory msgstore), else `undefined`.
- **YouTube**: ruhend-scraper's ytmp3/ytmp4 parsers are broken (`invalid onError`, `accessibilityData`). `.play`/`.yt` rewritten on `yt-search` + `@distube/ytdl-core`; m4a (itag-preferred) audio with correct mimetype, itag-18 mp4 video with a 60 MB guard, 30-min audio guard. Optional `YT_COOKIE` env (JSON array or raw header string) for datacenter-IP bot checks. ruhend remains only for tiktok/ig.
- **LID vs phone numbers**: WhatsApp LIDs (e.g. 2458828…@lid) are not phone numbers. `senderPhoneJid()` prefers the `*Alt` `@s.whatsapp.net` fields, `resolvePhoneJid()` uses Baileys' LID↔PN mapping, `quotedInfo()` prefers `participantAlt`; unresolvable → "(number hidden)" instead of fake digits. Applied to anti-delete, view-once, pins/quote attribution.
- **Global anti-delete**: `.antidelete all <number>` routes every chat's deletes to one DM (overrides per-chat toggles); `.antidelete all off` reverts.
- **`.tag` hidetag** added (invisible mentions), `.tagall` made primary over `.everyone`.
- **Polish audit**: `.airing` redesigned (dedupe by mal_id, English titles, tracked-first then score, top 10, truncation); expense weeks now start Monday (was dayjs' Sunday); `updatePomo` binds positionally (extra named params can throw on better-sqlite3 v12 — host runs v12, dev v9); stale `readdone del` usage text fixed; unused import cleanup.

## "Waiting for this message" recurrence — session-layer hardening (2026-07-07)
Recipients RECEIVING but failing to DECRYPT (placeholder) mid-session, DMs only, all at once = the bot's pairwise Signal sessions going stale. Three fixes:
1. **Teardown was corrupting state**: reconnects called `ev.removeAllListeners()` (no-op on Baileys' typed emitter without an event arg) + raw `ws.close()`, leaving the old socket's internals alive and mutating Signal sessions alongside the new socket. All teardown paths (reconnect, logout, manual) now use `sock.end(err)` — the only clean shutdown.
2. **`msgRetryCounterCache`** (NodeCache-compatible shim in msgstore.js) supplied to makeWASocket — retry receipts are now counted so Baileys forces a fresh session + resend when a recipient can't decrypt, instead of the message rotting.
3. **Rescue commands**: `.reset` (alias `.restart`) cleanly bounces the socket keeping the session — run it from a group if DMs are stuck; `.relink confirm` wipes the session and re-pairs (new code in the panel console). Both via lib/control.js restarter hook (no import cycle).
Ops note: only ONE instance may ever run against the session folder — a second instance (old container overlapping, local copy, duplicate server) advances ratchets independently and produces exactly this symptom.

## ROOT CAUSE of the recurring "waiting for message" (2026-07-07)
The real bug was socket overlap on reconnect, not the retry layer. When WhatsApp dropped the connection (~every 30 min of idle), `startBot()` built a new socket while the OLD socket's event listeners stayed attached and referenced the mutable module `sock`. A dying socket's late 'close' could then trigger a reconnect that killed the NEW healthy socket, and if `end()` didn't fully close the old ws, TWO companion connections briefly ran on the same identity — both advancing the Signal double-ratchet, which desyncs 1:1 DM sessions (groups use sender-keys and tolerate it). Hence: DMs only, mid-session, recurring.
Fix — **epoch guard + single-flight reconnect**: every socket generation gets a monotonic epoch; `scheduleReconnect()` bumps the epoch immediately (instantly invalidating the old socket's listeners), ends the old socket, nulls it, and arms exactly one delayed `startBot()`. Every handler early-returns `if (!isCurrent())`, and all handlers bind `thisSock` (their own generation) instead of the module var. Simulated: stacked + stale close events never spawn a 2nd socket (MAX concurrent = 1). `isRestarting` replaced by `reconnectArmed`. Kept: `msgRetryCounterCache`, exact-proto `getMessage`, `.reset`/`.relink`.

## Login methods (2026-07-06)
Mellow's "no-QR" SESSION_ID is really a pointer to a GitHub Gist holding creds.json that the generator site produced (the pairing still happened there, once). This bot now supports three login paths, in order: existing `session/` folder → `SESSION_ID` gist download (identical URL scheme to Mellow's lib/session.js, same generator account) → `PAIRING_NUMBER` pairing code (`sock.requestPairingCode`, fully local, no QR, no third-party holding creds — the recommended path) → QR in terminal as final fallback. Sticker pack name default changed to "𝐵𝑌 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺" per user (bot name stays without "BY").
