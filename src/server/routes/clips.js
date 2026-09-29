'use strict';

/**
 * Clip management routes: list, upload (trim + transcode), preview, delete.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const db = require('../db');
const clipStore = require('../clipStore');
const transcode = require('../transcode');
const { requireAuth, isAdmin } = require('../auth');

const router = express.Router();

const MAX_CLIPS = 200;
const MAX_TAGS = 8;

const upload = multer({
  dest: db.uploadsDir,
  limits: { fileSize: config.server.limits.maxUploadBytes, files: 1 },
});

/** Normalize a comma-separated tag string to a deduped, validated array. */
function parseTags(raw) {
  if (typeof raw !== 'string') return [];
  const tags = [];
  for (const part of raw.split(',')) {
    const tag = part.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 24);
    if (tag && /^[\p{L}\p{N} _-]+$/u.test(tag) && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

function toClipJson(row) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    tags: row.tags ? JSON.parse(row.tags) : [],
    durationMs: row.duration_ms,
    uploaderId: row.uploader_id,
    uploaderName: row.uploader_name,
    playCount: row.play_count,
    createdAt: row.created_at,
  };
}

/* GET /api/clips */
router.get('/', requireAuth, (_req, res) => {
  res.json(db.listClips().map(toClipJson));
});

/* GET /api/clips/:id/audio — OGG preview for the browser */
router.get('/:id/audio', requireAuth, (req, res) => {
  const clip = db.getClip(Number(req.params.id));
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.type('audio/ogg').sendFile(clipStore.oggPath(clip.id));
});

/* POST /api/clips — multipart: file, name, emoji?, color?, start, end */
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const tmpFile = req.file?.path;
  const cleanup = () => {
    if (tmpFile) fs.unlink(tmpFile, () => {});
  };

  try {
    if (!tmpFile) {
      res.status(400).json({ error: 'No audio file uploaded' });
      return;
    }
    if (db.countClips() >= MAX_CLIPS) {
      res.status(507).json({ error: `Clip limit reached (${MAX_CLIPS}) — delete some first.` });
      return;
    }

    const name = String(req.body.name ?? '').trim().slice(0, 64);
    if (!name) {
      res.status(400).json({ error: 'A clip name is required' });
      return;
    }
    if (db.findClipByName(name)?.name?.toLowerCase() === name.toLowerCase()) {
      res.status(409).json({ error: 'A clip with that name already exists' });
      return;
    }

    const emoji = String(req.body.emoji ?? '').trim().slice(0, 8) || null;
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color ?? '') ? req.body.color : null;
    const tags = parseTags(req.body.tags);

    // Never trust the client: probe server-side before touching ffmpeg.
    let probed;
    try {
      probed = await transcode.probe(tmpFile);
    } catch (err) {
      console.error('[clips] probe failed:', err.message);
      res.status(400).json({ error: 'File is not decodable audio' });
      return;
    }

    const start = Number.parseFloat(req.body.start ?? '0');
    const end = Number.parseFloat(req.body.end ?? String(probed.durationSeconds));
    const maxSec = config.server.limits.maxClipSeconds;
    if (
      !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end <= start || end > probed.durationSeconds + 0.5
    ) {
      res.status(400).json({ error: 'Invalid trim range' });
      return;
    }
    if (end - start > maxSec) {
      res.status(400).json({ error: `Clips are limited to ${maxSec} seconds after trimming` });
      return;
    }
    if (end - start < 0.2) {
      res.status(400).json({ error: 'Clip is too short' });
      return;
    }

    // Insert first to get the id that names the files; roll back on failure.
    const row = db.insertClip({
      name,
      emoji,
      color,
      tags: tags.length ? JSON.stringify(tags) : null,
      durationMs: Math.round((end - start) * 1000),
      uploaderId: req.user.userId,
      uploaderName: req.user.username,
      createdAt: Date.now(),
    });

    try {
      const { durationMs } = await transcode.transcode({
        input: tmpFile,
        start,
        end,
        outPcm: clipStore.pcmPath(row.id),
        outOgg: clipStore.oggPath(row.id),
      });
      db.db.prepare('UPDATE clips SET duration_ms = ? WHERE id = ?').run(durationMs, row.id);
      res.status(201).json(toClipJson({ ...row, duration_ms: durationMs }));
    } catch (err) {
      db.deleteClip(row.id);
      clipStore.removeFiles(row.id);
      throw err;
    }
  } catch (err) {
    console.error('[clips] upload failed:', err.message);
    res.status(500).json({ error: 'Failed to process the clip' });
  } finally {
    cleanup();
  }
});

/* PATCH /api/clips/:id — update name/emoji/tags (uploader or admin) */
router.patch('/:id', requireAuth, express.json(), (req, res) => {
  const clip = db.getClip(Number(req.params.id));
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (clip.uploader_id !== req.user.userId && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Only the uploader or an admin can edit this clip' });
    return;
  }

  const updates = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 64);
    if (!name) {
      res.status(400).json({ error: 'A clip name is required' });
      return;
    }
    const existing = db.findClipByName(name);
    if (existing && existing.id !== clip.id && existing.name.toLowerCase() === name.toLowerCase()) {
      res.status(409).json({ error: 'A clip with that name already exists' });
      return;
    }
    updates.name = name;
  }
  if (req.body?.emoji !== undefined) {
    updates.emoji = String(req.body.emoji ?? '').trim().slice(0, 8) || null;
  }
  if (req.body?.tags !== undefined) {
    const tags = parseTags(Array.isArray(req.body.tags) ? req.body.tags.join(',') : req.body.tags);
    updates.tags = tags.length ? JSON.stringify(tags) : null;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  db.updateClipMeta(clip.id, {
    name: clip.name,
    emoji: clip.emoji,
    tags: clip.tags,
    ...updates,
  });
  res.json(toClipJson(db.getClip(clip.id)));
});

/* DELETE /api/clips/:id — uploader or admin only */
router.delete('/:id', requireAuth, (req, res) => {
  const clip = db.getClip(Number(req.params.id));
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  if (clip.uploader_id !== req.user.userId && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Only the uploader or an admin can delete this clip' });
    return;
  }
  db.deleteClip(clip.id);
  clipStore.removeFiles(clip.id);
  res.status(204).end();
});

module.exports = router;
