'use strict';

/**
 * SQLite metadata store (better-sqlite3, synchronous — fine for this scale).
 * Clip audio lives on disk next to the DB; see clipStore.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../config');

const dataDir = config.server.dataDir || path.join(__dirname, '..', '..', 'data');
const clipsDir = path.join(dataDir, 'clips');
const uploadsDir = path.join(dataDir, 'uploads');
for (const dir of [dataDir, clipsDir, uploadsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'soundboard.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    emoji TEXT,
    color TEXT,
    duration_ms INTEGER NOT NULL,
    uploader_id TEXT NOT NULL,
    uploader_name TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Migration for databases created before tags existed.
const clipCols = db.prepare('PRAGMA table_info(clips)').all().map((c) => c.name);
if (!clipCols.includes('tags')) {
  db.exec('ALTER TABLE clips ADD COLUMN tags TEXT');
}

/* ─────────────────────────── clips ─────────────────────────── */

const stmts = {
  insertClip: db.prepare(`
    INSERT INTO clips (name, emoji, color, tags, duration_ms, uploader_id, uploader_name, created_at)
    VALUES (@name, @emoji, @color, @tags, @durationMs, @uploaderId, @uploaderName, @createdAt)
  `),
  listClips: db.prepare('SELECT * FROM clips ORDER BY created_at DESC'),
  getClip: db.prepare('SELECT * FROM clips WHERE id = ?'),
  getClipByName: db.prepare('SELECT * FROM clips WHERE name = ? COLLATE NOCASE'),
  searchClipByName: db.prepare("SELECT * FROM clips WHERE name LIKE ? COLLATE NOCASE ORDER BY play_count DESC LIMIT 1"),
  deleteClip: db.prepare('DELETE FROM clips WHERE id = ?'),
  bumpPlayCount: db.prepare('UPDATE clips SET play_count = play_count + 1 WHERE id = ?'),
  countClips: db.prepare('SELECT COUNT(*) AS n FROM clips'),
  updateClipMeta: db.prepare('UPDATE clips SET name = @name, emoji = @emoji, tags = @tags WHERE id = @id'),
};

function insertClip(fields) {
  const info = stmts.insertClip.run({ emoji: null, color: null, tags: null, ...fields });
  return stmts.getClip.get(info.lastInsertRowid);
}

function listClips() {
  return stmts.listClips.all();
}

function getClip(id) {
  return stmts.getClip.get(id);
}

/** Exact (case-insensitive) match first, then prefix search. */
function findClipByName(name) {
  return stmts.getClipByName.get(name) ?? stmts.searchClipByName.get(`${name}%`);
}

function deleteClip(id) {
  return stmts.deleteClip.run(id).changes > 0;
}

function bumpPlayCount(id) {
  stmts.bumpPlayCount.run(id);
}

function updateClipMeta(id, fields) {
  stmts.updateClipMeta.run({ id, ...fields });
}

function countClips() {
  return stmts.countClips.get().n;
}

/* ─────────────────────────── tokens ─────────────────────────── */

const tokenStmts = {
  insert: db.prepare(`
    INSERT OR REPLACE INTO tokens (token_hash, user_id, username, avatar, created_at, expires_at)
    VALUES (@tokenHash, @userId, @username, @avatar, @createdAt, @expiresAt)
  `),
  get: db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND expires_at > ?'),
  purge: db.prepare('DELETE FROM tokens WHERE expires_at <= ?'),
};

function insertToken(fields) {
  tokenStmts.insert.run(fields);
}

function getToken(tokenHash) {
  return tokenStmts.get.get(tokenHash, Date.now());
}

function purgeExpiredTokens() {
  tokenStmts.purge.run(Date.now());
}

module.exports = {
  db,
  dataDir,
  clipsDir,
  uploadsDir,
  insertClip,
  listClips,
  getClip,
  findClipByName,
  deleteClip,
  bumpPlayCount,
  updateClipMeta,
  countClips,
  insertToken,
  getToken,
  purgeExpiredTokens,
};
