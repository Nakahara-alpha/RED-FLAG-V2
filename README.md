# 🚩 𝑅𝛯𝐷 𝐹𝐿𝛥𝐺 V2

Personal WhatsApp utility bot for one power-user. Standalone Baileys bot — own session, own SQLite DB, fully isolated from any other bot.

## Setup

> 📖 **New here? See [INSTALL.md](INSTALL.md) — the complete step-by-step guide to install and run the bot on OptikLink** (no PC hosting): server setup, keys, pairing, first run, updating, troubleshooting.

1. **Configure** `config.env`:
   - `OWNER_NUMBER=234XXXXXXXXXX` (your number, digits only — comma-separate for more)
   - `GROQ_API_KEY` (free: console.groq.com) and/or `GEMINI_API_KEY` (free: aistudio.google.com) for the AI features
   - Optional: `PQ_DIR`, `MQTT_URL`, `NEXUS_API_URL`, `PREFIX` (default `.`, changeable live with `.prefix <symbol>`)
2. **Pick a login method** (config.env — or skip for QR):
   - `PAIRING_NUMBER=234…` → the bot prints an 8-char code; enter it at WhatsApp → Linked devices → *Link with phone number instead*. No scanning.
   - `SESSION_ID=<gist id>` → Mellow-style: downloads ready-made creds from the session generator's gist.
   - Neither set → a QR appears in the terminal to scan once.
3. **Run**:
   ```
   npm start
   ```
4. Send `.menu` to yourself.

> **Default prefix is `.`** (set by `PREFIX` in `config.env`). The command examples below are written with `!` for readability — substitute whatever prefix you've set, and change it live any time with `.prefix <symbol>`.

> `node_modules` is currently a junction into `../Mellow-MD-master/node_modules`. If you move this folder, run `npm i` inside it once to make it self-contained.

> **Hosting on a panel (optiklink, etc.) or running it for several people?** See [HOSTING.md](HOSTING.md) — step-by-step deploy, env-var config, persistent storage, and one-push updates for multiple client instances.

### Optional extras
- `npm i mqtt` — enables the ESP32 bridge (`!led`, `!room`, `!esp`)
- **ffmpeg** on PATH — enables video stickers and `!compress`

## What it does

| Area | Commands |
|---|---|
| Protection | `!antidelete` `!viewonce` `!antiword` `!antilink` `!alert` `!edittrack` `!vv` `!pvv` |
| Chat tools | `!busy` `!schedule` `!remind` `!remindme` `!export` `!ghost` `!pin` `!pins` `!findpin` |
| Productivity | `!todo` `!pomo` `!every` `!recurring` `!idea` `!ideas` `!later` `!readlist` |
| Trackers | `!monitor` (uptime alerts) `!bday` (birthday reminders) |
| AI | `!nexus` (assistant brain) `!ai` `!aimodel` `!summarize` `!tldr` `!tr` `!draft` `!ocr` `!transcribe` |
| Uni | `!tt` `!today` `!next` `!due` `!gpa` `!note` `!exam` `!countdown` `!pq` |
| IoT/System | `!led` `!room` `!esp` `!pc` `!nexus` `!status` |
| Daily | `!digest` `!spent` `!expenses` `!habit` `!airing` `!track` |
| Utility | `!qr` `!qrread` `!usd` `!fx` `!calc` `!conv` `!short` `!weather` `!define` `!wiki` |
| Media | `!yt` `!tiktok` `!ig` `!x` `!compress` `!sticker` `!toimg` `!meme` `!quote` |
| Group admin | `!everyone` `!tagnotadmin` `!warn` `!welcome` `!stats` `!poll` |

Everything is **owner-only** (your own messages, or numbers in `OWNER_NUMBER`) except the group-admin tools, which any group admin can use. Deleted messages, edits, and view-once media land in your own DM automatically. A daily digest (classes, deadlines, Lagos weather, anime) arrives at 06:30.

> **Ghost mode note:** `!ghost` only controls read receipts for messages *the bot* processes. Opening a chat yourself in the WhatsApp app still sends blue ticks — no bot can prevent that.

## Good to know

- **Protection is opt-in per chat**: turn on what you want where you want it — `!antidelete on`, `!viewonce on`, `!edittrack on`, `!alert on`. `!panic` kills all passive handlers everywhere instantly (`!panic off` restores).
- **Menu banner**: drop any image at `data/menu-banner.jpg` and `!menu` sends it with the menu as caption. No image = clean text menu.
- **`!help <command>`** gives usage + example for every command.
- **Restarts are safe**: reminders, schedules, recurring reminders, pomodoro, monitors, and backups all live in SQLite and resume on boot ("Rehydrated N scheduled items" in the console). Missed one-shots fire with a "(missed)" note; missed recurring slots roll forward without spamming.
- **All times are WAT** (UTC+1) no matter where the bot is hosted (`TZ_OFFSET_MIN` in config.env).
- **Backups**: `!backup` on demand; automatic nightly at 02:00, last 7 kept in `data/backups/`.
- **AI providers**: AI features use **AgentRouter** (`AGENTROUTER_API_KEY`, OpenAI-compatible — Claude/GPT/etc.) as primary when set, falling back to **Groq** then **Gemini**. Switch the AgentRouter model live with `!aimodel <id>` (`!aimodel list` to see what your key can use).
- **NEXUS** (`!nexus <anything>`): a conversational assistant — the bot's "brain" (powered by AgentRouter tool-calling). Instead of running data commands one by one, just tell it: *"remind me to call mum at 6pm"*, *"add CSC201 exam on the 20th at 9am"*, *"I spent 1500 on lunch"*, *"what's due this week?"*. It can set reminders/deadlines/classes/notes/ideas/todos/expenses/birthdays/recurring reminders and read them back, and it **remembers** facts across chats (`!nexus memory`, `!nexus forget <id>`, `!nexus reset`). It cannot delete data, message others, moderate groups, or control the PC — use the explicit commands for those.

See `DECISIONS.md` for every architectural/provider choice and `PROGRESS.md` for build status.
