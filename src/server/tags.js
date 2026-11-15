'use strict';

const MAX_TAGS = 8;

/**
 * Normalize tags (comma-separated string or array) to a deduped,
 * validated, lowercase array. Shared by clips and playlists so tag
 * filtering behaves identically on both.
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseTags(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof text !== 'string') return [];
  const tags = [];
  for (const part of text.split(',')) {
    // NFC + code-point slicing: a cut mid surrogate pair (or a decomposed
    // accent) used to fail the pattern and silently drop the whole tag.
    const words = part.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
    const tag = [...words].slice(0, 24).join('').trim();
    // \p{M}: combining marks (Devanagari, Thai vowel signs, ...) are part of words.
    if (tag && /^[\p{L}\p{M}\p{N} _-]+$/u.test(tag) && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

module.exports = { parseTags };
