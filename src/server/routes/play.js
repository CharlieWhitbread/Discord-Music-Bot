'use strict';

/**
 * Playback routes. HTTP is the fallback path — the primary press-to-sound
 * channel is the WebSocket (see ws.js) for latency reasons.
 */

const express = require('express');
const sessionManager = require('../../audio/sessionManager');
const db = require('../db');
const clipStore = require('../clipStore');
const { requireAuth } = require('../auth');

const router = express.Router();

/**
 * Shared by HTTP and WS paths.
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function triggerClip(clipId) {
  const clip = db.getClip(Number(clipId));
  if (!clip) return { ok: false, status: 404, error: 'Clip not found' };

  const buffer = clipStore.loadPcm(clip.id);
  if (!buffer) return { ok: false, status: 500, error: 'Clip audio is missing on disk' };

  const started = sessionManager.playClip({ id: clip.id, name: clip.name, buffer });
  if (!started) return { ok: false, status: 409, error: 'Bot is not in a voice channel — run /join in Discord' };

  db.bumpPlayCount(clip.id);
  return { ok: true };
}

/* POST /api/play/:clipId */
router.post('/play/:clipId', requireAuth, (req, res) => {
  const result = triggerClip(req.params.clipId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/* POST /api/stop */
router.post('/stop', requireAuth, (_req, res) => {
  sessionManager.stopClip();
  res.json({ ok: true });
});

/* GET /api/status */
router.get('/status', requireAuth, (_req, res) => {
  res.json(sessionManager.getStatus());
});

module.exports = { router, triggerClip };
