// Commands non-owners may run when a group has public mode ON (.public on).
// Curated to safe/fun/read-only commands — nothing that touches the owner's
// private data, config, system, or money. Kept in its own module so both the
// pipeline (handler.js) and the access commands can import it without a cycle.
export const PUBLIC_COMMANDS = new Set([
  // media & fun
  'play', 'meme', 'quote', 'sticker', 'toimg', 'qr', 'qrread',
  // downloaders
  'yt', 'tiktok', 'ig', 'x',
  // knowledge / utility
  'ai', 'tr', 'calc', 'conv', 'usd', 'fx', 'weather', 'define', 'wiki', 'short', 'airing',
  // harmless status
  'ping',
]);

export function publicBlocklist(getConfig, chatId) {
  return (getConfig(chatId, 'public_block', '') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}
