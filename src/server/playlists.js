'use strict';

/**
 * Web-app playlists ("Rocket League", "Chill", ...).
 *
 * Each one is a real private playlist on the linked Spotify account, so
 * playback uses it as the context: Spotify advances, shuffles and
 * resumes after queued songs by itself. SQLite only stores the tile
 * metadata (emoji, tags, shuffle) and which Spotify playlists are ours —
 * the account's other playlists are never listed.
 */

const { EventEmitter } = require('node:events');
const db = require('./db');
const spotify = require('./spotify');

const MAX_TRACKS = 500;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {object} Playlist
 * @property {number} id
 * @property {string} spotifyId
 * @property {string} name
 * @property {string|null} emoji
 * @property {string[]} tags
 * @property {boolean} shuffle
 * @property {number} trackCount
 * @property {string} creatorId
 * @property {string} creatorName
 * @property {number} playCount
 * @property {number} createdAt
 */

/** Emits 'update' with the full list whenever any playlist changes. */
const events = new EventEmitter();

/** @type {Map<number, {tracks: object[], fetchedAt: number}>} */
const trackCache = new Map();
/** @type {Map<number, Promise<unknown>>} per-playlist mutation chain */
const locks = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

/** @returns {Playlist} */
function toJson(row) {
  return {
    id: row.id,
    spotifyId: row.spotify_id,
    name: row.name,
    emoji: row.emoji,
    tags: row.tags ? JSON.parse(row.tags) : [],
    shuffle: Boolean(row.shuffle),
    trackCount: row.track_count,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    playCount: row.play_count,
    createdAt: row.created_at,
  };
}

function list() {
  return db.listPlaylists().map(toJson);
}

function emitUpdate() {
  events.emit('update', list());
}

function getRow(id) {
  const row = db.getPlaylist(id);
  if (!row) throw httpError(404, 'Playlist not found');
  return row;
}

/** Serialise mutations per playlist so concurrent adds can't duplicate. */
function withLock(id, fn) {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(id, run);
  run.finally(() => {
    if (locks.get(id) === run) locks.delete(id);
  }).catch(() => {});
  return run;
}

/**
 * @param {{name: string, emoji: string|null, tags: string[], shuffle: boolean}} fields
 * @param {{userId: string, username: string}} user
 */
async function create(fields, user) {
  const { id: spotifyId } = await spotify.createPlaylist(fields.name, 'Made with the Mr Blobby soundboard');
  const row = db.insertPlaylist({
    spotifyId,
    name: fields.name,
    emoji: fields.emoji,
    tags: fields.tags.length ? JSON.stringify(fields.tags) : null,
    shuffle: fields.shuffle ? 1 : 0,
    creatorId: user.userId,
    creatorName: user.username,
    createdAt: Date.now(),
  });
  trackCache.set(row.id, { tracks: [], fetchedAt: Date.now() });
  emitUpdate();
  return toJson(row);
}

/** Update tile metadata; shuffle applies live if this playlist is playing. */
async function update(id, fields) {
  const row = getRow(id);
  const next = {
    name: fields.name ?? row.name,
    emoji: fields.emoji !== undefined ? fields.emoji : row.emoji,
    tags: fields.tags !== undefined ? (fields.tags.length ? JSON.stringify(fields.tags) : null) : row.tags,
    shuffle: fields.shuffle !== undefined ? (fields.shuffle ? 1 : 0) : row.shuffle,
  };
  db.updatePlaylist(id, next);

  if (next.name !== row.name) {
    // The Spotify-side name is cosmetic; a failure mustn't block the edit.
    spotify.renamePlaylist(row.spotify_id, next.name).catch((err) => {
      console.error(`[playlists] rename on Spotify failed: ${err.message}`);
    });
  }
  if (next.shuffle !== row.shuffle && isPlaying(row)) {
    await spotify.setShuffle(Boolean(next.shuffle)).catch((err) => {
      console.error(`[playlists] live shuffle toggle failed: ${err.message}`);
    });
  }
  emitUpdate();
  return toJson(db.getPlaylist(id));
}

async function remove(id) {
  const row = getRow(id);
  try {
    await spotify.removePlaylist(row.spotify_id);
  } catch (err) {
    // Still forget it locally — a stray private playlist is harmless.
    console.error(`[playlists] removing "${row.name}" from Spotify failed: ${err.message}`);
  }
  db.deletePlaylist(id);
  trackCache.delete(id);
  emitUpdate();
}

/** @returns {Promise<object[]>} tracks, from cache when fresh */
async function getTracks(id, { fresh = false } = {}) {
  const row = getRow(id);
  const cached = trackCache.get(id);
  if (!fresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.tracks;
  const tracks = await spotify.getPlaylistTracks(row.spotify_id);
  trackCache.set(id, { tracks, fetchedAt: Date.now() });
  syncCount(row, tracks.length);
  return tracks;
}

function syncCount(row, count) {
  if (row.track_count === count) return;
  db.setPlaylistTrackCount(row.id, count);
  emitUpdate();
}

function addTrack(id, uri) {
  return withLock(id, async () => {
    const row = getRow(id);
    const tracks = await getTracks(id);
    if (tracks.some((t) => t.uri === uri)) throw httpError(409, 'Already in this playlist');
    if (tracks.length >= MAX_TRACKS) throw httpError(400, `Playlists are capped at ${MAX_TRACKS} songs`);
    const track = await spotify.getTrack(uri.split(':')[2]);
    await spotify.addPlaylistTracks(row.spotify_id, [uri]);
    tracks.push(track);
    syncCount(row, tracks.length);
    return track;
  });
}

function removeTrack(id, uri) {
  return withLock(id, async () => {
    const row = getRow(id);
    const tracks = await getTracks(id);
    await spotify.removePlaylistTracks(row.spotify_id, [uri]);
    const remaining = tracks.filter((t) => t.uri !== uri);
    trackCache.set(id, { tracks: remaining, fetchedAt: Date.now() });
    syncCount(row, remaining.length);
  });
}

function contextUri(row) {
  return `spotify:playlist:${row.spotify_id}`;
}

function isPlaying(row) {
  return spotify.getLastNowPlaying()?.context?.uri === contextUri(row);
}

/**
 * Play the whole playlist as the Spotify context. With shuffle on, start
 * at a random track (shuffle alone keeps the requested first track).
 */
async function play(id) {
  const row = getRow(id);
  const tracks = await getTracks(id);
  if (!tracks.length) throw httpError(400, 'This playlist is empty — add some songs first');
  const offset = row.shuffle ? Math.floor(Math.random() * tracks.length) : 0;
  await spotify.playContext(contextUri(row), offset);
  // Shuffle is a player setting; it can only be set once our device is active.
  await spotify.setShuffle(Boolean(row.shuffle)).catch((err) => {
    console.error(`[playlists] setting shuffle failed: ${err.message}`);
  });
  db.bumpPlaylistPlayCount(id);
  emitUpdate();
}

module.exports = {
  events,
  MAX_TRACKS,
  list,
  create,
  update,
  remove,
  getTracks,
  addTrack,
  removeTrack,
  play,
  get: (id) => toJson(getRow(id)),
};
