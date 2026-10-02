'use strict';

/**
 * Bot-owned song queue.
 *
 * Spotify's Web API can append to its native queue but can't inspect,
 * remove or reorder it — so the queue lives here instead. An adaptive
 * watcher polls now-playing only while the queue is non-empty and starts
 * the next queued track the moment the current one ends (or is skipped
 * from the Spotify app directly).
 */

const { EventEmitter } = require('node:events');
const spotify = require('./spotify');

/**
 * @typedef {object} QueueEntry
 * @property {number} id
 * @property {object} track   mapped Spotify track (uri, name, artists, ...)
 * @property {{userId: string, username: string}} addedBy
 * @property {number} addedAt epoch ms
 */

/** Emits 'update' with the current list whenever the queue changes. */
const events = new EventEmitter();

/** @type {QueueEntry[]} */
let items = [];
let nextId = 1;
let timer = null;
let checking = false;
/** URI of the track we're waiting on; a change means it ended/was skipped. */
let watchedUri = null;

/** @returns {QueueEntry[]} */
function list() {
  return items;
}

function hasItems() {
  return items.length > 0;
}

function emitUpdate() {
  events.emit('update', list());
}

/**
 * Add a track by URI. Metadata is fetched server-side so clients can't
 * spoof titles.
 * @param {string} uri spotify:track:<id>
 * @param {{userId: string, username: string}} user
 * @returns {Promise<QueueEntry>}
 */
async function add(uri, user) {
  const track = await spotify.getTrack(uri.split(':')[2]);
  const entry = {
    id: nextId++,
    track,
    addedBy: { userId: user.userId, username: user.username },
    addedAt: Date.now(),
  };
  items.push(entry);
  emitUpdate();
  schedule(500);
  return entry;
}

/** Remove an entry by id (anyone may remove). @returns {boolean} */
function remove(id) {
  const before = items.length;
  items = items.filter((e) => e.id !== id);
  if (items.length === before) return false;
  emitUpdate();
  if (!items.length) stopWatching();
  return true;
}

/**
 * Start the next queued track immediately (also used by the skip button).
 * On failure (e.g. bot not in voice → 409) the entry is put back and we
 * retry later.
 */
async function playNext() {
  const entry = items.shift();
  if (!entry) {
    stopWatching();
    return;
  }
  try {
    await spotify.playUri(entry.track.uri);
    watchedUri = entry.track.uri;
    emitUpdate();
    if (items.length) schedule(3000);
    else stopWatching();
  } catch (err) {
    items.unshift(entry);
    console.error(`[queue] failed to start "${entry.track.name}": ${err.message}`);
    schedule(10000);
    throw err;
  }
}

/* ───────────────────────── watcher internals ───────────────────────── */

function stopWatching() {
  clearTimeout(timer);
  timer = null;
  watchedUri = null;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    check().catch((err) => {
      console.error(`[queue] watcher error: ${err.message}`);
      if (items.length) schedule(10000);
    });
  }, ms);
  timer.unref();
}

/**
 * Adaptive poll: cheap 5 s checks mid-track, tightening near the end so
 * the handover gap stays small without hammering the API.
 */
async function check() {
  if (checking) return;
  if (!items.length || !spotify.connected()) {
    stopWatching();
    return;
  }
  checking = true;
  try {
    const np = await spotify.fetchNowPlaying();
    if (!np?.active || !np.track) {
      // Nothing playing — start the next queued track.
      await playNext().catch(() => {});
      return;
    }
    if (watchedUri && np.track.uri !== watchedUri) {
      // Track changed under us (ended into autoplay, or manually skipped)
      // — take over with the queue.
      await playNext().catch(() => {});
      return;
    }
    watchedUri = np.track.uri;
    if (!np.isPlaying) {
      schedule(5000); // paused — never advance, just keep watching
      return;
    }
    const remaining = (np.track.durationMs ?? 0) - (np.progressMs ?? 0);
    schedule(Math.min(Math.max(remaining - 700, 300), 5000));
  } finally {
    checking = false;
  }
}

module.exports = { events, list, hasItems, add, remove, playNext };
