# 🚩 RED FLAG V2 — Hosting & Multi-Client Deploy

How to run the bot on a panel host (optiklink, Pterodactyl-style panels, Railway,
a VPS, etc.) and run it for several people from one codebase.

## The model: one instance per client

RED FLAG V2 is a **single-owner** bot — one WhatsApp account, its own session, its
own SQLite DB. "Multiple clients" means **one running instance per person**, all
from the **same GitHub repo**. You push updates once; each client redeploys.

> This is *not* one process serving many WhatsApp numbers (that would be a much
> bigger rebuild). Each client = their own instance, their own number, their own data.

## 1. Prerequisites

- **Node.js 20+** (the panel's "Node" egg/image; set version to 20 or higher).
- A **GitHub repo** holding this code (push the folder as-is).
- Per client: their **WhatsApp number** and a phone to approve the link.

`.gitignore` already excludes `node_modules/`, `session/`, `db/*.db`, the `data/`
caches, and `config.env` — so pushing to GitHub leaks no secrets and never ships a
local `node_modules`. Let the panel install dependencies fresh.

## 2. First deploy (per instance)

1. **Pull the repo** on the panel (Git integration, or upload the files).
2. **Install command:** `npm install`
3. **Startup command:** `npm start`  (runs `node index.js`)
4. **Configure** (see §3), then (re)start.
5. Watch the console for the pairing code / QR and link the device (§4).
6. You'll get a DM to yourself: *"🚩 … is online."* Send `.menu`.

## 3. Configuration — env vars or config.env

The bot reads normal **environment variables** first and falls back to a
`config.env` file. On a panel, prefer the **Startup/Variables UI** — panel env
vars win, so you never commit secrets.

Minimum to boot:

| Variable | Value |
|---|---|
| `OWNER_NUMBER` | the client's number, digits only (e.g. `2348012345678`) |
| `PAIRING_NUMBER` | same number → prints an 8-char link code (or leave blank for QR) |

Everything else is optional and degrades gracefully. See
[`config.env.example`](config.env.example) for the full list with comments. Common ones:
`GROQ_API_KEY` / `GEMINI_API_KEY` (free AI), `AGENTROUTER_API_KEY` (primary AI +
NEXUS — default model `deepseek-v3.2`), `WEATHER_CITY`, `DIGEST_TIME`,
`NEWS_EDITION`, `PREFIX`.

## 4. Linking the WhatsApp account (one time)

Pick one — set it before the first start:

- **Pairing code (recommended, no scan):** set `PAIRING_NUMBER` to the client's
  number. The console prints `Pairing code for +234…: ABCD1234`. On the phone:
  **WhatsApp → Linked devices → Link a device → Link with phone number instead** →
  type the code. **Don't restart while the code is showing.**
- **QR:** leave `PAIRING_NUMBER` blank → a QR appears in the console; scan it.
- **SESSION_ID:** a GitHub Gist id holding a ready `creds.json` (Mellow-style).
  If `OWNER_NUMBER` is set, the bot refuses creds that aren't that number.

## 5. Persistent storage (critical)

The login and all data live on disk:

- `session/` — the WhatsApp link. Lose it → the client must re-pair.
- `db/redflag.db` — reminders, notes, GPA, NEXUS memory, everything.

**These must be on a persistent volume that survives redeploys/restarts.** On most
panels the server's own directory persists; just don't deploy in a way that wipes
the container. Safety net: `.backup` DMs the DB on demand, and an automatic backup
runs nightly at 02:00 (last 7 kept in `data/backups/`).

## 6. Updating all clients

1. Make changes → push to the GitHub repo.
2. Each client: **Pull** latest + **Restart** (or enable the panel's git auto-pull).
3. `node_modules` reinstalls from `package.json`; `session/` + `db/` are untouched,
   so no re-pairing and no data loss. The schema auto-migrates on boot.

## 7. Per-client checklist

- [ ] New server/instance on the panel from the repo
- [ ] `OWNER_NUMBER` + `PAIRING_NUMBER` set (their number)
- [ ] AI keys set if they want AI/NEXUS (`AGENTROUTER_API_KEY` and/or `GROQ`/`GEMINI`)
- [ ] `session/` + `db/` on persistent storage
- [ ] Started, linked, `.menu` works
- [ ] (optional) `TZ_OFFSET_MIN`, `WEATHER_CITY`, `NEWS_EDITION`, `PREFIX` tuned

## 8. Troubleshooting

- **"Waiting for this message" in DMs** → `.reset` (bounce the socket). If it
  persists, `.relink confirm` to re-pair. Make sure only **one** instance runs per
  account — two instances on the same number corrupt encryption.
- **"Logged out" loop** → the session died; the bot auto-wipes and re-pairs — watch
  the console for a fresh code.
- **AI says "down/rate-limited"** → the AgentRouter model may be plan-gated or out
  of budget. Run `.aimodel list`, then `.aimodel <id>` (DeepSeek ids are the
  reliable ones). Groq/Gemini keys act as automatic fallbacks.
- **`.pc` / screenshot does nothing** → those are Windows-only and target the
  *host*; on a Linux panel they just report "Windows only". Expected.
- **ffmpeg features** (`.compress`, video stickers) → need `ffmpeg` on the host;
  most panels don't have it — those features fail gracefully, the rest work.

## 9. optiklink notes

- Set the egg/image to **Node 20+**, install `npm install`, start `npm start`.
- Put config in the panel's **Variables** tab (not a committed file).
- Keep the server directory persistent so `session/` and `db/` survive restarts.
- `npm i mqtt` only if the client uses the ESP32 features.

