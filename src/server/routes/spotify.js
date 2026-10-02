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
const sessionManager = require('../../audio/sessionManager');

const router = express.Router();

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

/**
 * Instant-feel pause: mute the mixer locally right away, then send the
 * real pause. If the API call fails, unmute so audio isn't silently lost.
 * Shared by the HTTP route and the WebSocket handler.
 */
let mutedAt = 0;
async function pausePlayback() {
  sessionManager.setSpotifyMuted(true);
  mutedAt = Date.now();
  try {
    await spotify.pause();
  } catch (err) {
    sessionManager.setSpotifyMuted(false);
    throw err;
  }
}

// If playback is resumed from the Spotify app directly, unmute the mixer
// so we don't sit on silently-consumed PCM. The 5 s grace period stops a
// stale "playing" poll from undoing a just-issued instant pause.
spotify.events.on('nowplaying', (np) => {
  if (np?.isPlaying && Date.now() - mutedAt > 5000) {
    sessionManager.setSpotifyMuted(false);
  }
});

/** Counterpart of pausePlayback: unmute immediately, then resume. */
async function resumePlayback() {
  sessionManager.setSpotifyMuted(false);
  await spotify.resume();
}

/** Queue-aware skip: prefer the bot queue over Spotify autoplay. */
async function skipPlayback() {
  sessionManager.setSpotifyMuted(false);
  if (queue.hasItems()) await queue.playNext();
  else await spotify.next();
}

function sendError(res, err) {
  const status = err.status === 409 ? 409 : err.status === 403 ? 403 : 502;
  console.error(`[spotify] ${err.message}`);
  res.status(status).json({
    error: status === 502 ? 'Spotify request failed' : err.message,
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
    res.redirect(`${config.server.webOrigin}/?spotify=connected`);
  } catch (err) {
    console.error(`[spotify] callback failed: ${err.message}`);
    res.redirect(`${config.server.webOrigin}/?spotify=error`);
  }
});

/* ── status / search / controls (any member) ── */

router.get('/status', requireAuth, (req, res) => {
  res.json({
    configured: spotify.configured(),
    connected: spotify.connected(),
    canConnect: isAdmin(req.user),
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
    // "Play now" doesn't wipe the queue — it resumes after this track.
    sessionManager.setSpotifyMuted(false);
    await spotify.playUri(uri);
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
  const removed = queue.remove(Number(req.params.id));
  if (!removed) {
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
  previous: () => spotify.previous(),
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

module.exports = { router, pausePlayback, resumePlayback, skipPlayback };
