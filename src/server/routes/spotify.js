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

const router = express.Router();

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

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
    await spotify.playUri(uri);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/queue', requireAuth, requireConnected, async (req, res) => {
  const uri = String(req.body?.uri ?? '');
  if (!TRACK_URI.test(uri)) {
    res.status(400).json({ error: 'Invalid track uri' });
    return;
  }
  try {
    await spotify.queueUri(uri);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

for (const action of ['pause', 'resume', 'next', 'previous']) {
  router.post(`/${action}`, requireAuth, requireConnected, async (_req, res) => {
    try {
      await spotify[action]();
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
}

module.exports = router;
