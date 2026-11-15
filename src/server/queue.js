'use strict';

/**
 * Bot-owned song queue.
 *
 * Spotify's Web API can append to its native queue but can't inspect
 * who added what, remove or reorder — so the editable queue lives here.
 * Each entry is handed to Spotify's *native* queue shortly before the
 * current track ends. That keeps transitions gapless and, crucially,
 * leaves the playing context (e.g. a playlist) intact: Spotify plays the
 * queued song, then carries on with the playlist.
 *
 * The previous design started each queued song with PUT /play {uris},
 * which replaced the context and relied on catching the exact moment a
 * track ended — a finished single-track context reports "paused", which
 * looked identical to a user pause, so the queue silently stalled.
 */

const { EventEmitter } = require('node:events');
const spotify = require('./spotify');

/**
 * @typedef {object} QueueEntry
 * @property {number} id
 * @property {object} track   mapped Spotify track (uri, name, artists, ...)
 * @property {{userId: string, username: string}} addedBy
 * @property {number} addedAt epoch ms
 * @property {boolean} [locked] already handed to Spotify — plays next
 */

const HANDOVER_MS = 15_000; // hand the head to Spotify this long before the end
const IDLE_POLL_MS = 5_000;
const RETRY_MS = 10_000;
// Two track changes without our handed-over song appearing means it was
// lost (queue cleared in the Spotify app, account used elsewhere, ...).
const MAX_CHANGES_WHILE_HANDED = 2;
// Gap between back-to-back player commands so Spotify applies them in order.
const COMMAND_GAP_MS = 300;

/** Emits 'update' with the current list whenever the queue changes. */
const events = new EventEmitter();

/** @type {QueueEntry[]} */
let items = [];
/** @type {QueueEntry|null} in Spotify's native queue, not yet playing */
let handedOver = null;
let changesWhileHanded = 0;
let nextId = 1;
let timer = null;
/** @type {{uri: string, isPlaying: boolean, remainingMs: number}|null} */
let lastSeen = null;
/* Every player-touching operation (watcher tick, skip, play-now) runs
   through one chain: interleaving them let the watcher hand a song to
   Spotify in the middle of play-now's queue+skip sequence. */
let chain = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serial(fn) {
  const run = chain.catch(() => {}).then(fn);
  chain = run.catch(() => {});
  return run;
}

/** Remaining ms of the current track, corrected for the result's age. */
function remainingMs(np) {
  const age = np.isPlaying ? Date.now() - (np.fetchedAt ?? Date.now()) : 0;
  return np.track.durationMs - (np.progressMs ?? 0) - age;
}

/** Clear the handed-over entry once Spotify is actually playing it. */
function reconcile(np) {
  if (handedOver && np?.active && np.track.uri === handedOver.track.uri) {
    console.log(`[queue] now playing "${handedOver.track.name}"`);
    handedOver = null;
    emitUpdate();
  }
}

/** @returns {QueueEntry[]} handed-over entry first (locked), then pending */
function list() {
  return handedOver ? [{ ...handedOver, locked: true }, ...items] : items;
}

function hasItems() {
  return items.length > 0 || handedOver !== null;
}

function emitUpdate() {
  events.emit('update', list());
}

/**
 * Add a track by URI. Metadata is fetched server-side so clients can't
 * spoof titles. Starts it right away when nothing is playing at all.
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
  schedule(300);
  return entry;
}

/**
 * Remove a pending entry (anyone may remove).
 * @returns {'removed'|'locked'|'missing'}
 */
function remove(id) {
  if (handedOver?.id === id) return 'locked';
  const before = items.length;
  items = items.filter((e) => e.id !== id);
  if (items.length === before) return 'missing';
  emitUpdate();
  return 'removed';
}

/** Push an entry into Spotify's native queue. Restores it on failure. */
async function handOver(entry) {
  try {
    await spotify.queueUri(entry.track.uri);
    handedOver = entry;
    changesWhileHanded = 0;
    console.log(`[queue] handed "${entry.track.name}" to Spotify's queue`);
  } catch (err) {
    items.unshift(entry);
    throw err;
  } finally {
    emitUpdate();
  }
}

/** Nothing is playing at all — start the entry directly. */
async function startNow(entry) {
  try {
    await spotify.playUri(entry.track.uri);
    console.log(`[queue] started "${entry.track.name}"`);
  } catch (err) {
    items.unshift(entry);
    throw err;
  } finally {
    emitUpdate();
  }
}

/**
 * Skip: the next bot-queue song wins over the context's next track.
 */
function skip() {
  return serial(async () => {
    const np = await spotify.fetchNowPlaying();
    reconcile(np);
    if (handedOver) {
      await spotify.next(); // ours is already first in Spotify's queue
      schedule(1000);
      return;
    }
    const entry = items.shift();
    if (!entry) {
      await spotify.next();
      return;
    }
    if (!np?.active) {
      await startNow(entry);
      schedule(1000);
      return;
    }
    await handOver(entry);
    await sleep(COMMAND_GAP_MS);
    await spotify.next();
    schedule(1000);
  });
}

/**
 * "Play now" from search. With a playlist/album context playing, jump to
 * the song via the native queue so the context resumes afterwards;
 * otherwise there's nothing to preserve and a direct play is simplest.
 * @param {string} uri
 */
function playNow(uri) {
  return serial(async () => {
    const np = await spotify.fetchNowPlaying();
    reconcile(np);
    if (!np?.active || !np.context) {
      await spotify.playUri(uri);
      return;
    }
    await spotify.queueUri(uri);
    await sleep(COMMAND_GAP_MS);
    if (handedOver) {
      // Our handed-over song sits ahead of it in Spotify's queue: skip past
      // it too and put it back at the front of the bot queue.
      await spotify.next();
      await sleep(COMMAND_GAP_MS);
      items.unshift(handedOver);
      handedOver = null;
      emitUpdate();
    }
    await spotify.next();
    schedule(1000);
  });
}

/* ───────────────────────── watcher internals ───────────────────────── */

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    serial(check).catch((err) => {
      console.error(`[queue] watcher error: ${err.message}`);
      if (hasItems()) schedule(RETRY_MS);
    });
  }, ms);
  timer.unref();
}

/**
 * Adaptive poll: cheap checks mid-track, tightening so the handover lands
 * inside the last HANDOVER_MS. Runs only while the queue is non-empty.
 */
async function check() {
  if (!hasItems() || !spotify.connected()) {
    lastSeen = null;
    return;
  }
  const np = await spotify.fetchNowPlaying({ maxAgeMs: 1000 });
  const prev = lastSeen;
  lastSeen = np?.active
    ? { uri: np.track.uri, isPlaying: np.isPlaying, remainingMs: remainingMs(np) }
    : null;

  if (handedOver) {
    reconcile(np);
    if (handedOver && prev && np?.active && np.track.uri !== prev.uri) {
      changesWhileHanded++;
      if (changesWhileHanded >= MAX_CHANGES_WHILE_HANDED) {
        console.warn(`[queue] "${handedOver.track.name}" never played — dropping it`);
        handedOver = null;
        emitUpdate();
      }
    }
  }

  if (!np?.active) {
    // Nothing on the account is playing — start the queue ourselves.
    if (!handedOver && items.length) await startNow(items.shift());
    schedule(IDLE_POLL_MS);
    return;
  }

  if (!np.isPlaying) {
    // A track that ran out with nothing after it reports "paused" on the
    // same track. Tell that apart from a user pause by having seen it
    // playing right at the end.
    const ended = prev?.isPlaying && prev.uri === np.track.uri && prev.remainingMs < 4000;
    if (ended && !handedOver && items.length) await startNow(items.shift());
    schedule(IDLE_POLL_MS);
    return;
  }

  const remaining = remainingMs(np);
  if (!handedOver && items.length && remaining <= HANDOVER_MS) {
    await handOver(items.shift());
  }
  if (!hasItems()) return;
  const untilHandover = remaining - HANDOVER_MS;
  const wait = !handedOver && untilHandover > 0
    ? untilHandover + 200
    : remaining + 1000; // check the handed-over song started
  schedule(Math.min(Math.max(wait, 500), IDLE_POLL_MS));
}

module.exports = { events, list, hasItems, add, remove, skip, playNow };
