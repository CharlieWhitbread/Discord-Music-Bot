'use strict';

/**
 * /api/spotify — jukebox routes.
 *
 * Any authenticated guild member can search and control playback.
 * Connecting the Spotify account (login/callback) is admin-only: the
 * whole bot plays through the owner's Premium account.
 */

const express = require('express');
const config = require('../../config');
const { requireAuth, resolveToken, isAdmin } = require('../auth');
const spotify = require('../spotify');
const queue = require('../queue');
const playlists = require('../playlists');
const { parseTags } = require('../tags');
const sessionManager = require('../../audio/sessionManager');

const router = express.Router();

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

/**
 * Instant-feel pause: mute the mixer locally right away, then send the
 * real pause. The mute is only a bridge over the Web API's latency, so it
 * releases itself once librespot has had time to stop producing PCM —
 * a mute left on after a resume from the Spotify app (or a queue/playlist
 * starting) was the "says it's playing but there's no sound" bug.
 * Shared by the HTTP route and the WebSocket handler.
 */
const PAUSE_MUTE_MS = 2000;
let unmuteTimer = null;

function unmute() {
  clearTimeout(unmuteTimer);
  unmuteTimer = null;
  sessionManager.setSpotifyMuted(false);
}

async function pausePlayback() {
  sessionManager.setSpotifyMuted(true);
  clearTimeout(unmuteTimer);
  unmuteTimer = setTimeout(unmute, PAUSE_MUTE_MS);
  unmuteTimer.unref();
  try {
    await spotify.pause();
  } catch (err) {
    unmute();
    throw err;
  }
}

/** Counterpart of pausePlayback: unmute immediately, then resume. */
async function resumePlayback() {
  unmute();
  await spotify.resume();
}

/** Queue-aware skip: the next bot-queue song wins over the context. */
async function skipPlayback() {
  unmute();
  await queue.skip();
}

function sendError(res, err) {
  // Surface Spotify's own reason for player/playlist rejections (e.g.
  // "Restriction violated"); hide anything else behind a generic 502.
  const status = err.status === 409 ? 409
    : err.status === 400 || err.status === 403 || err.status === 404 ? err.status
    : 502;
  console.error(`[spotify] ${err.message}`);
  res.status(status).json({
    error: status === 502 ? 'Spotify request failed'
      : err.detail ? `Spotify: ${err.detail}`
      : err.message,
  });
}

function requireConnected(_req, res, next) {
  if (!spotify.connected()) {
    res.status(503).json({ error: 'Spotify is not connected yet' });
    return;
  }
  next();
}

/* ── account linking (admin only) ── */

// Browser navigation can't send an Authorization header, so the token
// rides in the query string just for this hop.
router.get('/login', (req, res) => {
  if (!spotify.configured()) {
    res.status(500).json({ error: 'Spotify is not configured on the server' });
    return;
  }
  const user = resolveToken(`Bearer ${req.query.token ?? ''}`);
  if (!user || !isAdmin(user)) {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  res.redirect(spotify.loginUrl());
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  try {
    if (error || !code || !state) throw new Error(String(error || 'Missing code'));
    await spotify.handleCallback(String(code), String(state));
    res.redirect(`${config.server.webOrigin}/?spotify=connected#spotify`);
  } catch (err) {
    console.error(`[spotify] callback failed: ${err.message}`);
    res.redirect(`${config.server.webOrigin}/?spotify=error#spotify`);
  }
});

/* ── status / search / controls (any member) ── */

router.get('/status', requireAuth, async (req, res) => {
  const connected = spotify.connected();
  res.json({
    configured: spotify.configured(),
    connected,
    canConnect: isAdmin(req.user),
    // Linked before playlists existed → the admin must reconnect once.
    playlists: connected && await spotify.hasPlaylistAccess(),
  });
});

router.get('/search', requireAuth, requireConnected, async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 200);
  if (!q) {
    res.json([]);
    return;
  }
  try {
    res.json(await spotify.search(q));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/play', requireAuth, requireConnected, async (req, res) => {
  const uri = String(req.body?.uri ?? '');
  if (!TRACK_URI.test(uri)) {
    res.status(400).json({ error: 'Invalid track uri' });
    return;
  }
  try {
    unmute();
    await queue.playNow(uri);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/* ── bot-owned queue (view/add/remove for any member) ── */

router.get('/queue', requireAuth, (_req, res) => {
  res.json(queue.list());
});

router.post('/queue', requireAuth, requireConnected, async (req, res) => {
  const uri = String(req.body?.uri ?? '');
  if (!TRACK_URI.test(uri)) {
    res.status(400).json({ error: 'Invalid track uri' });
    return;
  }
  try {
    res.status(201).json(await queue.add(uri, req.user));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/queue/:id', requireAuth, (req, res) => {
  const result = queue.remove(Number(req.params.id));
  if (result === 'locked') {
    res.status(409).json({ error: 'Already handed to Spotify — it plays next' });
    return;
  }
  if (result === 'missing') {
    res.status(404).json({ error: 'Not in queue' });
    return;
  }
  res.json({ ok: true });
});

/* ── transport controls ── */

const controls = {
  pause: pausePlayback,
  resume: resumePlayback,
  next: skipPlayback,
  previous: () => {
    unmute();
    return spotify.previous();
  },
};
for (const [action, run] of Object.entries(controls)) {
  router.post(`/${action}`, requireAuth, requireConnected, async (_req, res) => {
    try {
      await run();
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
}

// Music-only volume; works even without an active Spotify connection.
router.post('/volume', requireAuth, (req, res) => {
  const value = Number(req.body?.value);
  if (!Number.isFinite(value)) {
    res.status(400).json({ error: 'Invalid volume' });
    return;
  }
  res.json({ ok: true, value: sessionManager.setMusicVolume(value) });
});

/* ── playlists (web-app playlists only) ──
 * Anyone can play, add/remove songs and toggle shuffle (it's a shared
 * jukebox); renaming and deleting is limited to the creator or an admin,
 * matching soundboard clips. */

async function requirePlaylistAccess(_req, res, next) {
  if (!(await spotify.hasPlaylistAccess())) {
    res.status(403).json({ error: 'Playlists need Spotify to be reconnected once by an admin' });
    return;
  }
  next();
}

const playlistGuards = [requireAuth, requireConnected, requirePlaylistAccess];

function playlistId(req) {
  return Number(req.params.id);
}

/** Validate create/update fields. @returns {object|string} fields or an error */
function parsePlaylistFields(body, { partial }) {
  const fields = {};
  if (body?.name !== undefined || !partial) {
    const name = String(body?.name ?? '').trim().slice(0, 64);
    if (!name) return 'A playlist name is required';
    fields.name = name;
  }
  if (body?.emoji !== undefined) fields.emoji = String(body.emoji ?? '').trim().slice(0, 8) || null;
  else if (!partial) fields.emoji = null;
  if (body?.tags !== undefined) fields.tags = parseTags(body.tags);
  else if (!partial) fields.tags = [];
  if (body?.shuffle !== undefined) fields.shuffle = Boolean(body.shuffle);
  else if (!partial) fields.shuffle = false;
  if (partial && Object.keys(fields).length === 0) return 'Nothing to update';
  return fields;
}

function canManage(user, playlist) {
  return playlist.creatorId === user.userId || isAdmin(user);
}

router.get('/playlists', requireAuth, (_req, res) => {
  res.json(playlists.list());
});

router.post('/playlists', ...playlistGuards, async (req, res) => {
  const fields = parsePlaylistFields(req.body, { partial: false });
  if (typeof fields === 'string') {
    res.status(400).json({ error: fields });
    return;
  }
  try {
    res.status(201).json(await playlists.create(fields, req.user));
  } catch (err) {
    sendError(res, err);
  }
});

router.patch('/playlists/:id', ...playlistGuards, async (req, res) => {
  const fields = parsePlaylistFields(req.body, { partial: true });
  if (typeof fields === 'string') {
    res.status(400).json({ error: fields });
    return;
  }
  try {
    const playlist = playlists.get(playlistId(req));
    const metaChange = ['name', 'emoji', 'tags'].some((k) => k in fields);
    if (metaChange && !canManage(req.user, playlist)) {
      res.status(403).json({ error: 'Only the creator or an admin can rename or retag this playlist' });
      return;
    }
    res.json(await playlists.update(playlist.id, fields));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/playlists/:id', ...playlistGuards, async (req, res) => {
  try {
    const playlist = playlists.get(playlistId(req));
    if (!canManage(req.user, playlist)) {
      res.status(403).json({ error: 'Only the creator or an admin can delete this playlist' });
      return;
    }
    await playlists.remove(playlist.id);
    res.status(204).end();
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/playlists/:id/tracks', ...playlistGuards, async (req, res) => {
  try {
    res.json(await playlists.getTracks(playlistId(req), { fresh: req.query.fresh === '1' }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/playlists/:id/tracks', ...playlistGuards, async (req, res) => {
  const uri = String(req.body?.uri ?? '');
  if (!TRACK_URI.test(uri)) {
    res.status(400).json({ error: 'Invalid track uri' });
    return;
  }
  try {
    res.status(201).json(await playlists.addTrack(playlistId(req), uri));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/playlists/:id/tracks', ...playlistGuards, async (req, res) => {
  const uri = String(req.body?.uri ?? '');
  if (!TRACK_URI.test(uri)) {
    res.status(400).json({ error: 'Invalid track uri' });
    return;
  }
  try {
    await playlists.removeTrack(playlistId(req), uri);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/playlists/:id/play', ...playlistGuards, async (req, res) => {
  try {
    unmute();
    await playlists.play(playlistId(req));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = { router, pausePlayback, resumePlayback, skipPlayback };
