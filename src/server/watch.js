'use strict';

/**
 * watch — shared "watch together" state for the YouTube tab.
 *
 * No video ever touches the Pi: every browser streams from YouTube with its
 * own (Premium) session. The server only holds the authoritative playback
 * anchor — position at a server timestamp — so clients can compute where
 * they should be right now and correct drift locally. It also owns the
 * "up next" queue and advances it when the current video ends.
 */

const { EventEmitter } = require('node:events');

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_POSITION_S = 24 * 60 * 60;
const MAX_QUEUE = 50;
const OEMBED_TIMEOUT_MS = 4000;
// Grace past the reported duration before the server advances on its own
// (a client's "ended" report normally arrives first).
const END_GRACE_MS = 1500;

/**
 * @typedef {{userId: string, username: string}} Actor
 * @typedef {object} QueuedVideo
 * @property {number} id
 * @property {string} videoId
 * @property {string|null} title
 * @property {Actor} addedBy
 * @property {number} addedAt
 *
 * @typedef {object} WatchState
 * @property {string|null} videoId
 * @property {string|null} title
 * @property {number|null} duration  seconds, reported by clients
 * @property {boolean} playing
 * @property {number} position   seconds, as of updatedAt
 * @property {number} updatedAt  server epoch ms of the anchor
 * @property {Actor|null} by     last actor
 * @property {string|null} action  last action
 * @property {QueuedVideo[]} queue
 */

/** Emits 'update' with the current state whenever it changes. */
const events = new EventEmitter();

/** @type {WatchState} */
let state = {
  videoId: null,
  title: null,
  duration: null,
  playing: false,
  position: 0,
  updatedAt: Date.now(),
  by: null,
  action: null,
  queue: [],
};
let nextQueueId = 1;
let endTimer = null;

function httpError(message) {
  const err = new Error(message);
  err.expose = true;
  return err;
}

/** @returns {WatchState} */
function get() {
  return state;
}

function currentPosition() {
  if (!state.playing) return state.position;
  return state.position + (Date.now() - state.updatedAt) / 1000;
}

function actor(user) {
  return user ? { userId: user.userId, username: user.username } : null;
}

/**
 * Apply a change. updatedAt always moves to now, so the position must be
 * re-anchored too — otherwise a queue edit would rewind everyone.
 */
function commit(patch, user, action) {
  const position = 'position' in patch ? patch.position : currentPosition();
  state = { ...state, ...patch, position, updatedAt: Date.now(), by: actor(user), action };
  armEndTimer();
  events.emit('update', state);
}

function toPosition(value) {
  // Number(null|''|[]|false) is 0 — junk like that must not rewind everyone.
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), MAX_POSITION_S);
}

function validId(videoId) {
  return typeof videoId === 'string' && VIDEO_ID_RE.test(videoId);
}

/**
 * Title + embeddability via oEmbed (no API key needed). YouTube answers
 * 401/403 for videos whose owner disabled embedding and 400/404 for
 * missing/private ones — reject those up front instead of letting every
 * client hit a player error. Network trouble just means no title.
 * @returns {Promise<{title: string|null}>}
 */
async function lookup(videoId) {
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('format', 'json');
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[watch] oEmbed lookup failed for ${videoId}: ${err.message}`);
    return { title: null };
  }
  if (res.status === 401 || res.status === 403) throw httpError('The owner doesn’t allow this video to be embedded');
  if (res.status === 400 || res.status === 404) throw httpError('Video not found (removed or private)');
  if (!res.ok) return { title: null };
  const data = await res.json().catch(() => null);
  return { title: typeof data?.title === 'string' ? data.title.slice(0, 200) : null };
}

/* ─────────────────────────── playback ─────────────────────────── */

/** Play a video right now (the queue is kept). */
async function load(videoId, user) {
  if (!validId(videoId)) throw httpError('Invalid YouTube video');
  const { title } = await lookup(videoId);
  commit({ videoId, title, duration: null, playing: true, position: 0 }, user, 'load');
}

/**
 * Play/pause/seek. The client sends its own player position so the anchor
 * matches what the actor actually saw; falls back to the server's estimate.
 * @param {'play'|'pause'|'seek'} action
 */
function control(action, position, user) {
  if (!state.videoId) return false;
  const pos = toPosition(position) ?? currentPosition();
  if (action === 'play') commit({ playing: true, position: pos }, user, action);
  else if (action === 'pause') commit({ playing: false, position: pos }, user, action);
  else if (action === 'seek') commit({ position: pos }, user, action);
  else return false;
  return true;
}

/** Stop for everyone (the queue is kept). */
function clear(user) {
  commit({ videoId: null, title: null, duration: null, playing: false, position: 0 }, user, 'clear');
}

/* ─────────────────────────── queue ─────────────────────────── */

/** Queue a video; starts it straight away when nothing is on. */
async function enqueue(videoId, user) {
  if (!validId(videoId)) throw httpError('Invalid YouTube video');
  if (state.queue.length >= MAX_QUEUE) throw httpError(`The queue is full (${MAX_QUEUE} videos)`);
  const { title } = await lookup(videoId);
  // Re-check: other enqueues may have landed while the lookup was in flight.
  if (state.queue.length >= MAX_QUEUE) throw httpError(`The queue is full (${MAX_QUEUE} videos)`);
  if (!state.videoId) {
    commit({ videoId, title, duration: null, playing: true, position: 0 }, user, 'load');
    return;
  }
  const entry = { id: nextQueueId++, videoId, title, addedBy: actor(user), addedAt: Date.now() };
  commit({ queue: [...state.queue, entry] }, user, 'enqueue');
}

function dequeue(id, user) {
  const queue = state.queue.filter((e) => e.id !== Number(id));
  if (queue.length === state.queue.length) return false;
  commit({ queue }, user, 'dequeue');
  return true;
}

/** Start the next queued video, or stop at the end if there is none. */
function advance(user, action) {
  const [nextUp, ...rest] = state.queue;
  if (nextUp) {
    commit({
      videoId: nextUp.videoId, title: nextUp.title, duration: null, playing: true, position: 0, queue: rest,
    }, user ?? nextUp.addedBy, action);
  } else {
    commit({ playing: false, position: state.duration ?? currentPosition() }, user, 'ended');
  }
}

/** Skip to the next queued video. */
function skip(user) {
  if (!state.queue.length) return false;
  advance(user, 'skip');
  return true;
}

/**
 * A client saw the video end. Every viewer reports it, so only the first
 * report for the *current* video counts.
 */
function ended(videoId) {
  if (videoId !== state.videoId || !state.playing) return;
  // Ignore an early "ended" from a client that drifted or seeked alone.
  if (state.duration && currentPosition() < state.duration - 5) return;
  advance(null, 'advance');
}

/**
 * Clients report the duration once their player knows it. The server uses
 * it to advance even when nobody has the YouTube tab open.
 */
function reportDuration(videoId, duration) {
  const d = Number(duration);
  if (videoId !== state.videoId || state.duration || !Number.isFinite(d) || d <= 0 || d > MAX_POSITION_S) return;
  state = { ...state, duration: d };
  armEndTimer();
}

function armEndTimer() {
  clearTimeout(endTimer);
  endTimer = null;
  if (!state.videoId || !state.playing || !state.duration) return;
  const videoId = state.videoId;
  const ms = (state.duration - currentPosition()) * 1000 + END_GRACE_MS;
  endTimer = setTimeout(() => {
    if (state.videoId === videoId && state.playing) advance(null, 'advance');
  }, Math.max(ms, 0));
  endTimer.unref();
}

/** Teardown: no timers left behind. */
function stop() {
  clearTimeout(endTimer);
  endTimer = null;
}

module.exports = {
  events, get, load, control, clear, enqueue, dequeue, skip, ended, reportDuration, stop,
};
