'use strict';

const { setupEnv } = require('./helpers/env');

setupEnv();

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTags } = require('../src/server/tags');
const db = require('../src/server/db');
const clipStore = require('../src/server/clipStore');

const clipFields = (name) => ({ name, durationMs: 1000, uploaderId: 'u1', uploaderName: 'U', createdAt: Date.now() });

describe('parseTags', () => {
  test('splits, trims, lowercases, collapses whitespace and dedupes', () => {
    assert.deepEqual(parseTags(' Hype ,  GAMING   time, hype,,'), ['hype', 'gaming time']);
  });

  test('accepts arrays and ignores non-strings', () => {
    assert.deepEqual(parseTags(['a', 'B']), ['a', 'b']);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(42), []);
    assert.deepEqual(parseTags({ toString: () => 'x' }), []);
  });

  test('caps at 8 tags and 24 characters each', () => {
    const many = Array.from({ length: 12 }, (_, i) => `t${i}`).join(',');
    assert.equal(parseTags(many).length, 8);
    assert.equal(parseTags('x'.repeat(40))[0].length, 24);
  });

  test('allows unicode letters/digits, spaces, _ and -; rejects other symbols', () => {
    assert.deepEqual(parseTags('café,日本語, naïve-mode, snake_case, ünï 2'), ['café', '日本語', 'naïve-mode', 'snake_case', 'ünï 2']);
    assert.deepEqual(parseTags('<script>, 🔥, a/b, ok'), ['ok']);
  });

  test('duplicates count once against the cap', () => {
    assert.deepEqual(parseTags('a,a,a,a,a,a,a,a,a,b'), ['a', 'b']);
  });

  test('scripts with combining marks and decomposed accents are kept', () => {
    assert.deepEqual(parseTags('संगीत, เพลง'), ['संगीत', 'เพลง']);
    assert.deepEqual(parseTags('cafe\u0301'), ['café'], 'NFD input normalised to NFC');
  });

  test('truncation never splits a surrogate pair (the tag used to vanish)', () => {
    const astral = `${'a'.repeat(23)}𝒜𝒜`;
    assert.deepEqual(parseTags(astral), [`${'a'.repeat(23)}𝒜`]);
  });

  test('a cut that ends in a space is trimmed', () => {
    assert.deepEqual(parseTags(`${'a'.repeat(23)} b`), ['a'.repeat(23)]);
  });
});

describe('db', () => {
  test('clip names are unique case-insensitively', () => {
    db.insertClip(clipFields('Bruh'));
    assert.throws(() => db.insertClip(clipFields('bRUH')), /UNIQUE/);
  });

  test('findClipByName prefers an exact match over a prefix', () => {
    db.insertClip(clipFields('Horn Long'));
    db.insertClip(clipFields('Horn'));
    assert.equal(db.findClipByName('horn').name, 'Horn');
    assert.equal(db.findClipByName('horn l').name, 'Horn Long');
    assert.equal(db.findClipByName('zzz'), undefined);
  });

  test('deleting a clip removes everyone’s favourites of it', () => {
    const clip = db.insertClip(clipFields('FavMe'));
    const other = db.insertClip(clipFields('Keep'));
    db.setFavorite('u1', clip.id, true);
    db.setFavorite('u1', clip.id, true); // idempotent
    db.setFavorite('u2', clip.id, true);
    db.setFavorite('u1', other.id, true);
    assert.deepEqual(db.listFavorites('u1'), [clip.id, other.id]);
    assert.equal(db.deleteClip(clip.id), true);
    assert.deepEqual(db.listFavorites('u1'), [other.id]);
    assert.deepEqual(db.listFavorites('u2'), []);
    assert.equal(db.deleteClip(clip.id), false);
  });

  test('tokens expire and are purged', () => {
    const now = Date.now();
    db.insertToken({ tokenHash: 'live', userId: 'a', username: 'A', avatar: null, createdAt: now, expiresAt: now + 60_000 });
    db.insertToken({ tokenHash: 'dead', userId: 'b', username: 'B', avatar: null, createdAt: now, expiresAt: now - 1 });
    assert.equal(db.getToken('live').user_id, 'a');
    assert.equal(db.getToken('dead'), undefined, 'expired token never resolves');
    db.purgeExpiredTokens();
    const remaining = db.db.prepare('SELECT token_hash FROM tokens').all().map((r) => r.token_hash);
    assert.deepEqual(remaining, ['live']);
  });

  test('playlist rows round-trip', () => {
    const row = db.insertPlaylist({
      spotifyId: 'sp1', name: 'Chill', emoji: null, tags: null, shuffle: 0, creatorId: 'u', creatorName: 'U', createdAt: 1,
    });
    db.setPlaylistTrackCount(row.id, 3);
    db.bumpPlaylistPlayCount(row.id);
    assert.equal(db.getPlaylist(row.id).track_count, 3);
    assert.equal(db.getPlaylist(row.id).play_count, 1);
    assert.equal(db.deletePlaylist(row.id), true);
    assert.equal(db.getPlaylist(row.id), undefined);
  });
});

describe('clipStore', () => {
  const write = (id, bytes) => fs.writeFileSync(clipStore.pcmPath(id), Buffer.alloc(bytes, id % 256));

  test('paths are confined to the clips dir', () => {
    assert.equal(path.dirname(clipStore.pcmPath(7)), db.clipsDir);
    assert.equal(path.basename(clipStore.oggPath(7)), '7.ogg');
  });

  test('loadPcm caches, returns null for missing files, and removeFiles evicts', () => {
    write(1001, 100);
    const a = clipStore.loadPcm(1001);
    fs.unlinkSync(clipStore.pcmPath(1001));
    assert.equal(clipStore.loadPcm(1001), a, 'served from memory, not disk');
    clipStore.removeFiles(1001);
    assert.equal(clipStore.loadPcm(1001), null);
    assert.equal(clipStore.loadPcm(424242), null);
  });

  test('LRU evicts the least recently used clip past 100 MB', () => {
    const MB = 1024 * 1024;
    write(2001, 40 * MB);
    write(2002, 40 * MB);
    write(2003, 40 * MB);
    const first = clipStore.loadPcm(2001);
    clipStore.loadPcm(2002);
    assert.equal(clipStore.loadPcm(2001), first, 'touch 2001 so 2002 becomes the oldest');
    clipStore.loadPcm(2003); // 120 MB > cap → evict 2002
    for (const id of [2001, 2002, 2003]) fs.unlinkSync(clipStore.pcmPath(id));
    assert.equal(clipStore.loadPcm(2001), first, '2001 still cached');
    assert.ok(clipStore.loadPcm(2003), '2003 still cached');
    assert.equal(clipStore.loadPcm(2002), null, '2002 was evicted');
    for (const id of [2001, 2003]) clipStore.removeFiles(id);
  });
});
