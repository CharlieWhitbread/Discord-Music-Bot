'use strict';

const { setupEnv } = require('./helpers/env');

const dataDir = setupEnv();

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { makeFixtures, makeHlsProbe } = require('./helpers/audioFixtures');

// Track concurrent ffmpeg transcodes (probes excluded). transcode.js
// destructures spawn at load, so wrap it first.
const originalSpawn = childProcess.spawn;
let running = 0;
let maxRunning = 0;
childProcess.spawn = (bin, args, opts) => {
  const child = originalSpawn(bin, args, opts);
  if (!/ffprobe/i.test(bin)) {
    running++;
    maxRunning = Math.max(maxRunning, running);
    child.on('exit', () => { running--; });
  }
  return child;
};
const transcode = require('../src/server/transcode');

let fx;
const outDir = path.join(dataDir, 'out');
before(() => {
  fs.mkdirSync(outDir, { recursive: true });
  fx = makeFixtures(dataDir);
});

const outputs = (name) => ({ outPcm: path.join(outDir, `${name}.pcm`), outOgg: path.join(outDir, `${name}.ogg`) });

describe('probe', () => {
  test('reads the duration of real audio (any container)', async () => {
    assert.ok(Math.abs((await transcode.probe(fx['tone.wav'])).durationSeconds - 2) < 0.05);
    assert.ok(Math.abs((await transcode.probe(fx['tone.ogg'])).durationSeconds - 1) < 0.05);
  });

  for (const name of ['notes.txt', 'empty.wav', 'fake.wav', 'silent-video.mp4']) {
    test(`rejects ${name}`, async () => {
      await assert.rejects(transcode.probe(fx[name]));
    });
  }

  test('an uploaded HLS playlist cannot make ffprobe fetch URLs (SSRF)', async () => {
    const hls = await makeHlsProbe(dataDir);
    try {
      await assert.rejects(transcode.probe(hls.file));
      assert.deepEqual(hls.hits, []);
    } finally {
      hls.close();
    }
  });
});

describe('transcode', () => {
  test('trims to canonical s16le/48 kHz/stereo PCM plus an Opus preview', async () => {
    const out = outputs('trim');
    const { durationMs } = await transcode.transcode({ input: fx['tone.wav'], start: 0.5, end: 1.5, ...out });
    const size = fs.statSync(out.outPcm).size;
    assert.equal(size % 4, 0, 'whole stereo 16-bit samples');
    assert.ok(Math.abs(size - transcode.PCM_BYTES_PER_SECOND) <= 3840 * 2, `≈1 s of PCM, got ${size} bytes`);
    assert.ok(Math.abs(durationMs - 1000) <= 40);
    assert.equal(fs.readFileSync(out.outOgg).subarray(0, 4).toString(), 'OggS');
  });

  test('jobs run one at a time, and a failing job does not block the queue', async () => {
    maxRunning = 0;
    const jobs = [
      transcode.transcode({ input: fx['tone.wav'], start: 0, end: 1, ...outputs('a') }),
      transcode.transcode({ input: path.join(dataDir, 'missing.wav'), start: 0, end: 1, ...outputs('b') }),
      transcode.transcode({ input: fx['tone.ogg'], start: 0, end: 0.5, ...outputs('c') }),
      transcode.transcode({ input: fx['tone.wav'], start: 1, end: 2, ...outputs('d') }),
    ];
    const results = await Promise.allSettled(jobs);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    assert.equal(maxRunning, 1, 'never more than one ffmpeg at a time');
  });
});
