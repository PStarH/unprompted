/**
 * Bounded reads for untrusted response bodies.
 *
 * A provider (or a misconfigured file) can return an arbitrarily large body.
 * Reading it with `response.text()` before checking the size defeats the limit:
 * the whole payload is already in memory. This helper reads incrementally when
 * the transport exposes a stream, refuses the body as soon as the cap is
 * crossed, and only falls back to `text()`/`json()` for simple test doubles.
 */

export async function readTextBounded(response, maxChars, label = 'Response') {
  const limit = Number(maxChars);
  const reader = response?.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;

  if (!reader) {
    if (typeof response?.text !== 'function') {
      if (typeof response?.json === 'function') return response.json();
      throw new Error(`${label} has no readable body`);
    }
    const text = await response.text();
    if (limit > 0 && text.length > limit) throw new Error(`${label} exceeds ${limit} characters`);
    return text;
  }

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (limit > 0 && text.length > limit) {
        try { await reader.cancel(); } catch { /* the body is being discarded anyway */ }
        throw new Error(`${label} exceeds ${limit} characters`);
      }
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* already released */ }
  }
  text += decoder.decode();
  if (limit > 0 && text.length > limit) throw new Error(`${label} exceeds ${limit} characters`);
  return text;
}

/** Bound the serialized tool envelope, including JSON escaping. Offsets always
 * describe the actual delivered chunk, so neither harness cuts JSON mid-field. */
export function jsonTextChunk(metadata, content, offset = 0, { readChars = 4000, maxChars = 5800 } = {}) {
  const encode = end => ({ ...metadata, offset, content: content.slice(offset, end), nextOffset: end < content.length ? end : null });
  let low = Math.min(offset, content.length), high = Math.min(content.length, offset + readChars);
  if (JSON.stringify(encode(low)).length > maxChars) throw new Error('Tool metadata exceeds its bounded response window.');
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(encode(mid)).length <= maxChars) low = mid; else high = mid - 1;
  }
  return encode(low);
}

export const boundedApi = { readTextBounded, jsonTextChunk };
