'use strict';

/**
 * clipStore — PCM/OGG files on disk + an in-memory PCM cache so a button
 * press never touches the SD card on the hot path.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

// Clips are ≤ 30 s ≈ 5.8 MB of PCM; cap the cache well under Pi RAM limits.
const CACHE_MAX_BYTES = 100 * 1024 * 1024;

/** @type {Map<number, Buffer>} clipId → PCM (insertion order = LRU-ish) */
const cache = new Map();
let cacheBytes = 0;

function pcmPath(id) {
  return path.join(db.clipsDir, `${id}.pcm`);
}

function oggPath(id) {
  return path.join(db.clipsDir, `${id}.ogg`);
}

/**
 * Load a clip's PCM, from cache when possible.
 * @param {number} id
 * @returns {Buffer|null}
 */
function loadPcm(id) {
  const cached = cache.get(id);
  if (cached) {
    // Refresh recency.
    cache.delete(id);
    cache.set(id, cached);
    return cached;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(pcmPath(id));
  } catch {
    return null;
  }

  cache.set(id, buffer);
  cacheBytes += buffer.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const [oldestId, oldest] = cache.entries().next().value;
    cache.delete(oldestId);
    cacheBytes -= oldest.length;
  }
  return buffer;
}

/** Remove a clip's files and cache entry (called on delete). */
function removeFiles(id) {
  const cached = cache.get(id);
  if (cached) {
    cache.delete(id);
    cacheBytes -= cached.length;
  }
  for (const file of [pcmPath(id), oggPath(id)]) {
    try {
      fs.unlinkSync(file);
    } catch { /* already gone */ }
  }
}

module.exports = { pcmPath, oggPath, loadPcm, removeFiles };
