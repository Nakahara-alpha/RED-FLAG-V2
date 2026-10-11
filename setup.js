// setup.js — one-file bootstrapper + installer for panels (OptikLink etc.).
//
// You can deploy the WHOLE bot by uploading ONLY this file and pointing the panel
// at it (BOT_JS_FILE=setup.js, or startup `node setup.js`). On boot it will:
//   0. CLONE the project from GitHub if the code isn't here yet (index.js missing)
//   1. git pull the latest code      (if it's a git checkout; skip with AUTO_UPDATE=0)
//   2. npm install                   (only when deps are missing or the code changed)
//   3. ensure a config.env exists    (copies config.env.example the first time)
//   4. launch the bot (index.js)     in THIS process, so panel Stop/Restart works
//
// Repo defaults below; override with the GIT_ADDRESS (or REPO_URL) + BRANCH env
// vars the panel already exposes. Uses only Node built-ins so it runs bare.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = 'https://github.com/Nakahara-alpha/RED-FLAG-V2';
const REPO_URL = (process.env.GIT_ADDRESS || process.env.REPO_URL || DEFAULT_REPO).trim();
const BRANCH = (process.env.BRANCH || 'main').trim();
const log = (m) => console.log(`[setup] ${m}`);
const isWin = process.platform === 'win32';

function run(cmd, args) {
  const bin = isWin && cmd === 'npm' ? 'npm.cmd' : cmd;
  const r = spawnSync(bin, args, { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// ── 0. fetch the code if it isn't here (bare setup.js upload) ────────────────
function ensureCode() {
  if (fs.existsSync(path.join(ROOT, 'index.js'))) return; // already have the project
  if (capture('git', ['--version']) === null) {
    log('ERROR: index.js is missing and git is unavailable. Upload the full project, or install git.');
    process.exit(1);
  }
  log(`project not found here — cloning ${REPO_URL} (${BRANCH})…`);
  const tmp = path.join(ROOT, '.rf-clone-tmp');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  if (!run('git', ['clone', '--depth', '1', '--branch', BRANCH, REPO_URL, tmp])) {
    log('ERROR: git clone failed — check GIT_ADDRESS/BRANCH and that the repo is public.');
    process.exit(1);
  }
  // Copy the clone (including .git, so future AUTO_UPDATE pulls work) into ROOT,
  // overwriting the stray/default files the egg may have left behind.
  for (const entry of fs.readdirSync(tmp)) {
    fs.cpSync(path.join(tmp, entry), path.join(ROOT, entry), { recursive: true, force: true });
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  log('project fetched.');
}

// ── 1. auto-update from git ──────────────────────────────────────────────────
function gitUpdate() {
  if (process.env.AUTO_UPDATE === '0') { log('AUTO_UPDATE=0 — skipping git pull.'); return false; }
  if (!fs.existsSync(path.join(ROOT, '.git'))) { log('not a git checkout — skipping update.'); return false; }
  if (capture('git', ['--version']) === null) { log('git not available — skipping update.'); return false; }
  const before = capture('git', ['rev-parse', 'HEAD']);
  log('syncing with GitHub…');
  // Force-match the remote. `reset --hard` only touches TRACKED files — config.env,
  // session/ and db/ are gitignored, so they're never affected. This also
  // self-heals a dirty working tree (e.g. a locally-modified package.json) that
  // would otherwise abort a plain `git pull`.
  if (!run('git', ['fetch', 'origin', BRANCH])) { log('git fetch failed (continuing with current code).'); return false; }
  if (!run('git', ['reset', '--hard', `origin/${BRANCH}`])) { log('git reset failed (continuing with current code).'); return false; }
  const after = capture('git', ['rev-parse', 'HEAD']);
  const changed = before && after && before !== after;
  log(changed ? `updated ${before.slice(0, 7)} → ${after.slice(0, 7)}.` : 'already up to date.');
  return changed;
}

// ── 2. dependencies ──────────────────────────────────────────────────────────
function ensureDeps(codeChanged) {
  const marker = path.join(ROOT, 'node_modules', '@innovatorssoft', 'baileys', 'package.json');
  const haveDeps = fs.existsSync(marker);
  if (haveDeps && !codeChanged) { log('dependencies present.'); return true; }
  log(haveDeps ? 'code changed — running npm install…' : 'installing dependencies (first run, may take a minute)…');
  if (!run('npm', ['install', '--no-audit', '--no-fund'])) {
    log('ERROR: npm install failed. Check Node is 20+ and the console above for the reason.');
    process.exit(1);
  }
  return true;
}

// ── 3. config.env ────────────────────────────────────────────────────────────
function ensureConfig() {
  const cfg = path.join(ROOT, 'config.env');
  const example = path.join(ROOT, 'config.env.example');
  if (fs.existsSync(cfg)) return;
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, cfg);
    log('created config.env from the template.');
    log('⚠️  Edit config.env (set OWNER_NUMBER + PAIRING_NUMBER + any API keys), then restart.');
  } else {
    log('⚠️  No config.env — relying on panel environment variables (OWNER_NUMBER, PAIRING_NUMBER, …).');
  }
}

// ── 3b. patch a known bug in the Baileys fork ────────────────────────────────
// The fork (@innovatorssoft/baileys 7.4.3) calls groupFetchAllParticipating()
// inside chats.js's `CB:ib,,dirty` (groups) handler, but that function lives in
// the groups layer which chats can't see → it's undefined → the handler throws
// on an INBOUND frame, so messages the user sends are never delivered. Upstream
// Baileys doesn't fetch groups from chats at all. We guard the call so the
// handler finishes (and cleanDirtyBits runs, clearing the server's dirty flag).
// Idempotent; re-applied every boot so it survives npm reinstalls.
function patchBaileys() {
  const f = path.join(ROOT, 'node_modules', '@innovatorssoft', 'baileys', 'lib', 'Socket', 'chats.js');
  try {
    if (!fs.existsSync(f)) return;
    const s = fs.readFileSync(f, 'utf8');
    const patched = s.replace(
      /^(\s*)await groupFetchAllParticipating\(\)\s*$/m,
      "$1if (typeof groupFetchAllParticipating === 'function') { await groupFetchAllParticipating(); }",
    );
    if (patched !== s) {
      fs.writeFileSync(f, patched);
      log('patched Baileys chats.js (groupFetchAllParticipating guard — fixes message reception).');
    } else {
      log('Baileys patch not needed (already guarded or upstream build).');
    }
  } catch (e) {
    log(`Baileys patch skipped: ${e.message}`);
  }
}

// ── 4. launch ────────────────────────────────────────────────────────────────
async function main() {
  log(`starting in ${ROOT}`);
  ensureCode(); // clone the project if only setup.js is here
  let codeChanged = false;
  try { codeChanged = gitUpdate(); } catch (e) { log(`update step error (continuing): ${e.message}`); }
  ensureDeps(codeChanged);
  patchBaileys();
  ensureConfig();
  log('launching the bot…');
  await import('./index.js'); // runs in-process so panel Stop/Restart signals reach it
}

main().catch((err) => {
  console.error('[setup] fatal:', err);
  process.exit(1);
});
