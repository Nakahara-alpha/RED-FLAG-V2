// repair.js — one-shot fixer for a server whose `git pull` is stuck on local
// changes (e.g. "your local changes to package.json would be overwritten").
//
// Use: upload this file to /home/container, set BOT_JS_FILE=repair.js, Restart.
// It force-resets the checkout to match GitHub exactly (gitignored files like
// config.env / session/ / db/ are untouched), then boots the bot via setup.js.
// Safe to leave as BOT_JS_FILE, or switch back to setup.js afterwards.
import { spawnSync } from 'child_process';
const opt = { cwd: '/home/container', stdio: 'inherit' };
console.log('[repair] force-syncing to origin/main…');
spawnSync('git', ['fetch', 'origin', 'main'], opt);
spawnSync('git', ['reset', '--hard', 'origin/main'], opt);
console.log('[repair] done. launching via setup.js');
await import('./setup.js');
