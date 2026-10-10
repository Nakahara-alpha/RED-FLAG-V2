// Optional Mellow-style session bootstrap: SESSION_ID is a GitHub Gist id whose
// raw creds.json was uploaded by the session-generator site. If set and no local
// session exists, we download it — otherwise QR / pairing-code login is used.
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITHUB_USERNAME = 'DemmyJay-99'; // same generator account as Mellow

export async function initSessionFromGist(sessionID) {
  const sessionDir = path.join(__dirname, '..', 'session');
  const credsPath = path.join(sessionDir, 'creds.json');

  if (fs.existsSync(credsPath)) {
    try { JSON.parse(fs.readFileSync(credsPath, 'utf8')); return true; } catch { /* re-download */ }
  }
  if (!sessionID) return false;

  const gistURL = `https://gist.githubusercontent.com/${GITHUB_USERNAME}/${sessionID}/raw/creds.json`;
  const res = await fetch(gistURL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`SESSION_ID download failed (HTTP ${res.status}) — check the id.`);
  const data = await res.text();
  const creds = JSON.parse(data);
  if (!creds.noiseKey || !creds.signedIdentityKey || !creds.me?.id || !creds.registered) {
    throw new Error('Downloaded session is invalid or unregistered.');
  }
  // A gist id is effectively public, so if OWNER_NUMBER is configured, refuse any
  // creds that don't belong to the owner — stops a wrong/hostile creds file from
  // being adopted as this bot's identity.
  const owners = (process.env.OWNER_NUMBER || '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  if (owners.length) {
    const meNum = String(creds.me.id).split(':')[0].split('@')[0].replace(/\D/g, '');
    if (!owners.includes(meNum)) {
      throw new Error('Downloaded session does not belong to OWNER_NUMBER — refusing it.');
    }
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(credsPath, data);
  console.log('[RF] Session downloaded from SESSION_ID (Mellow-style).');
  return true;
}
