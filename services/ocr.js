import { aiVision } from './ai-client.js';

/** Extract text from an image buffer. */
export async function ocrImage(buffer, mimeType = 'image/jpeg') {
  const text = await aiVision(
    buffer,
    mimeType,
    'Extract ALL text visible in this image, exactly as written. Preserve line breaks. If there is no text, say "No text found."',
  );
  return text;
}
