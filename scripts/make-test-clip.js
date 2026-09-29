'use strict';

/**
 * Generates a 2-second test clip ("test") directly into the clip store so
 * the mixer can be exercised with /sound test before the web app exists.
 *
 *   node scripts/make-test-clip.js
 */

const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const db = require('../src/server/db');
const clipStore = require('../src/server/clipStore');

const existing = db.findClipByName('test');
if (existing?.name === 'test') {
  console.log('Test clip already exists (id', existing.id + ')');
  process.exit(0);
}

const row = db.insertClip({
  name: 'test',
  emoji: '🔔',
  color: '#5865F2',
  durationMs: 2000,
  uploaderId: 'system',
  uploaderName: 'system',
  createdAt: Date.now(),
});

// Two-tone chime, faded to avoid clicks.
const filter = 'sine=frequency=660:duration=2,afade=t=in:d=0.05,afade=t=out:st=1.8:d=0.2';

let result = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', filter,
  '-f', 's16le', '-ar', '48000', '-ac', '2',
  '-y', clipStore.pcmPath(row.id),
], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('ffmpeg failed generating PCM');

result = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 's16le', '-ar', '48000', '-ac', '2',
  '-i', clipStore.pcmPath(row.id),
  '-c:a', 'libopus', '-b:a', '96k',
  '-y', clipStore.oggPath(row.id),
], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('ffmpeg failed generating OGG');

console.log(`Created test clip (id ${row.id}). Try /join then /sound test.`);
