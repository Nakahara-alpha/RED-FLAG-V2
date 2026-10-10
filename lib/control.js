// Lets commands (.reset / .relink) restart the socket owned by index.js
// without an import cycle.
let restarter = null;

export function setRestarter(fn) { restarter = fn; }

/** Restart the socket. wipeSession=true also deletes creds → fresh pairing. */
export async function requestRestart(wipeSession = false) {
  if (!restarter) throw new Error('restarter not ready');
  await restarter(wipeSession);
}
