'use strict';

/**
 * HTTP API integration: the real Express app (server.start()) on a free
 * port, AUTH_DISABLED (every request is the "dev" user), Spotify faked.
 * Multi-user permissions and real auth live in auth.test.js.
 */

const { setupEnv, captureConsole } = require('./helpers/env');
const { freePort, startServer, call } = require('./helpers/server');
const { FakeSpotify, FULL_SCOPE } = require('./helpers/fakeSpotify');
const { makeFixtures } = require('./helpers/audioFixtures');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let srv;
let base;
let dataDir;
let fx;
let fake;
let db;
let sessionManager;
let clipStore;
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

before(async () => {
  const port = await freePort();
  dataDir = setupEnv({
    SOUNDBOARD_PORT: String(port),
    SPOTIFY_CLIENT_ID: 'sp-client',
    SPOTIFY_CLIENT_SECRET: 'sp-secret',
    PUBLIC_API_URL: 'https://api.test',
  }, { spotifyAuth: { refreshToken: 'refresh-0', scope: FULL_SCOPE } });
  fake = new FakeSpotify().install();
  fake.addTracks(10);
  fx = makeFixtures(dataDir);
  db = require('../src/server/db');
  clipStore = require('../src/server/clipStore');
  sessionManager = require('../src/audio/sessionManager');
  srv = await startServer();
  base = srv.base;
});

after(() => {
  srv?.stop();
  fake?.uninstall();
});

beforeEach((t) => {
  captureConsole(t);
});

const api = (method, urlPath, opts) => call(base, method, urlPath, opts);
const trackUri = (n) => `spotify:track:T${String(n).padStart(21, '0')}`;

function uploadForm(file, fields = {}, filename = path.basename(file)) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}
// Each upload from its own client IP (trust proxy honours X-Forwarded-For),
// so functional tests don't drain the 20/hour upload bucket.
let uploadIp = 0;
const upload = (file, fields, filename) => api('POST', '/api/clips', {
  form: uploadForm(file, fields, filename),
  headers: { 'X-Forwarded-For': `10.1.${uploadIp >> 8}.${uploadIp++ & 255}` },
});
const uploadsLeft = () => fs.readdirSync(db.uploadsDir);

function assertErrorShape(res, status) {
  assert.equal(res.status, status);
  assert.equal(typeof res.body?.error, 'string', `JSON {error} body, got ${JSON.stringify(res.body)}`);
  assert.ok(!/at .*\.js:\d+/.test(res.body.error), 'no stack traces');
}

describe('clips', () => {
  let tone;

  test('upload: transcodes, stores files and returns the clip', async () => {
    const res = await upload(fx['tone.wav'], { name: 'Tone', emoji: '🔔', color: '#FF0000', tags: 'Hype, beep', start: '0.25', end: '1.25' });
    assert.equal(res.status, 201);
    tone = res.body;
    assert.equal(tone.name, 'Tone');
    assert.deepEqual(tone.tags, ['hype', 'beep']);
    assert.equal(tone.color, '#FF0000');
    assert.equal(tone.uploaderId, 'dev');
    assert.ok(Math.abs(tone.durationMs - 1000) < 50);
    assert.ok(fs.existsSync(clipStore.pcmPath(tone.id)));
    assert.deepEqual(uploadsLeft(), [], 'temp upload removed');

    const audio = await fetch(`${base}/api/clips/${tone.id}/audio`);
    assert.equal(audio.status, 200);
    assert.match(audio.headers.get('content-type'), /audio\/ogg/);
  });

  test('upload validation', async () => {
    assertErrorShape(await api('POST', '/api/clips', { form: new FormData() }), 400);
    assertErrorShape(await upload(fx['tone.wav'], {}), 400); // no name
    assertErrorShape(await upload(fx['tone.wav'], { name: '   ' }), 400);
    const dup = await upload(fx['tone.wav'], { name: 'tONE' });
    assertErrorShape(dup, 409);
    for (const [start, end] of [['-1', '1'], ['1', '1'], ['1.5', '1'], ['0', '9'], ['abc', '1'], ['0', 'Infinity']]) {
      assertErrorShape(await upload(fx['tone.wav'], { name: `bad ${start}-${end}`, start, end }), 400);
    }
    const short = await upload(fx['tone.wav'], { name: 'blip', start: '0', end: '0.1' });
    assertErrorShape(short, 400);
    assert.match(short.body.error, /too short/);
    assert.deepEqual(uploadsLeft(), [], 'every rejected upload cleaned up');
  });

  test('upload: an unsupported color/emoji is normalised, a field-name mismatch is a 400', async () => {
    const res = await upload(fx['tone.wav'], { name: 'Colorless', color: 'red; background:url(x)', emoji: '🎉🎉🎉🎉🎉🎉' });
    assert.equal(res.status, 201);
    assert.equal(res.body.color, null);
    assert.ok(res.body.emoji.length <= 8);

    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(fx['tone.wav'])]), 'x.wav');
    assertErrorShape(await api('POST', '/api/clips', { form }), 400);
  });

  test('upload: non-audio files are rejected by ffprobe', async () => {
    for (const name of ['notes.txt', 'empty.wav', 'fake.wav', 'silent-video.mp4']) {
      const res = await upload(fx[name], { name: `x-${name}` });
      assertErrorShape(res, 400);
      assert.match(res.body.error, /not decodable audio/);
    }
    assert.deepEqual(uploadsLeft(), []);
  });

  test('upload: the 30 s cap applies after trimming', async () => {
    const over = await upload(fx['long.wav'], { name: 'Long' });
    assertErrorShape(over, 400);
    assert.match(over.body.error, /30 seconds/);
    const trimmed = await upload(fx['long.wav'], { name: 'Long', start: '1', end: '31' });
    assert.equal(trimmed.status, 201);
  });

  test('upload: a path-traversal filename never escapes the uploads dir', async () => {
    const res = await upload(fx['tone.wav'], { name: 'Traversal' }, '../../../evil.wav');
    assert.equal(res.status, 201);
    for (const dir of [dataDir, path.dirname(dataDir), db.clipsDir]) {
      assert.ok(!fs.existsSync(path.join(dir, 'evil.wav')));
    }
    assert.deepEqual(uploadsLeft(), []);
  });

  test('concurrent uploads all succeed through the serial transcode queue', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => upload(fx['tone.ogg'], { name: `Parallel ${n}` })));
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201]);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 3);
  });

  test('concurrent uploads with the same name: one wins, the other is a 409', async () => {
    const results = await Promise.all([upload(fx['tone.ogg'], { name: 'Race' }), upload(fx['tone.ogg'], { name: 'RACE' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.deepEqual(uploadsLeft(), []);
  });

  test('PATCH edits name/emoji/tags with validation', async () => {
    let res = await api('PATCH', `/api/clips/${tone.id}`, { json: { name: 'Tone 2', tags: ['a', 'A', 'b'], emoji: '' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Tone 2');
    assert.deepEqual(res.body.tags, ['a', 'b']);
    assert.equal(res.body.emoji, null);
    res = await api('PATCH', `/api/clips/${tone.id}`, { json: { name: 'tone 2' } });
    assert.equal(res.status, 200, 'renaming to itself (different case) is fine');
    assertErrorShape(await api('PATCH', `/api/clips/${tone.id}`, { json: { name: 'long' } }), 409);
    assertErrorShape(await api('PATCH', `/api/clips/${tone.id}`, { json: { name: ' ' } }), 400);
    assertErrorShape(await api('PATCH', `/api/clips/${tone.id}`, { json: {} }), 400);
    assertErrorShape(await api('PATCH', '/api/clips/99999', { json: { name: 'x' } }), 404);
  });

  test('favourites: star, list, unstar; 404 for unknown clips', async () => {
    let res = await api('PUT', `/api/clips/${tone.id}/favorite`);
    assert.deepEqual(res.body, [tone.id]);
    res = await api('PUT', `/api/clips/${tone.id}/favorite`);
    assert.deepEqual(res.body, [tone.id], 'idempotent');
    assert.deepEqual((await api('GET', '/api/clips/favorites')).body, [tone.id]);
    res = await api('DELETE', `/api/clips/${tone.id}/favorite`);
    assert.deepEqual(res.body, []);
    assertErrorShape(await api('PUT', '/api/clips/424242/favorite'), 404);
  });

  test('ids that are not integers (incl. traversal attempts) are 404s', async () => {
    for (const id of ['abc', '1.5abc', '..%2F..%2Fsoundboard.db', '%00', '-1']) {
      assertErrorShape(await api('GET', `/api/clips/${id}/audio`), 404);
      assertErrorShape(await api('DELETE', `/api/clips/${id}`), 404);
    }
  });

  test('DELETE removes the clip, its files and everyone’s favourites', async () => {
    await api('PUT', `/api/clips/${tone.id}/favorite`);
    assert.equal((await api('DELETE', `/api/clips/${tone.id}`)).status, 204);
    assert.ok(!fs.existsSync(clipStore.pcmPath(tone.id)));
    assert.ok(!fs.existsSync(clipStore.oggPath(tone.id)));
    assert.deepEqual((await api('GET', '/api/clips/favorites')).body, []);
    assertErrorShape(await api('DELETE', `/api/clips/${tone.id}`), 404);
  });

  test('the 200-clip limit is a 507', async () => {
    const ids = [];
    for (let n = db.countClips(); n < 200; n++) {
      ids.push(db.insertClip({ name: `filler ${n}`, durationMs: 1, uploaderId: 'x', uploaderName: 'x', createdAt: 0 }).id);
    }
    assertErrorShape(await upload(fx['tone.wav'], { name: 'One too many' }), 507);
    for (const id of ids) db.deleteClip(id);
  });
});

describe('playback routes', () => {
  let clip;
  before(async () => {
    clip = (await upload(fx['tone.ogg'], { name: 'Playable' })).body;
  });

  test('not in voice → 409 with a hint', async () => {
    const res = await api('POST', `/api/play/${clip.id}`);
    assertErrorShape(res, 409);
    assert.match(res.body.error, /\/join/);
  });

  test('plays through sessionManager and counts the play', async (t) => {
    const played = [];
    t.mock.method(sessionManager, 'playClip', (c) => { played.push(c); return true; });
    assert.equal((await api('POST', `/api/play/${clip.id}`)).status, 200);
    assert.equal(played[0].id, clip.id);
    assert.ok(Buffer.isBuffer(played[0].buffer) && played[0].buffer.length % 4 === 0);
    assert.equal(db.getClip(clip.id).play_count, 1);
  });

  test('unknown clip → 404, audio missing on disk → 500 with a message', async (t) => {
    t.mock.method(sessionManager, 'playClip', () => true);
    assertErrorShape(await api('POST', '/api/play/987654'), 404);
    const ghost = db.insertClip({ name: 'Ghost', durationMs: 1, uploaderId: 'x', uploaderName: 'x', createdAt: 0 });
    const res = await api('POST', `/api/play/${ghost.id}`);
    assertErrorShape(res, 500);
    assert.match(res.body.error, /missing on disk/);
  });

  test('stop and status', async () => {
    assert.deepEqual((await api('POST', '/api/stop')).body, { ok: true });
    const status = (await api('GET', '/api/status')).body;
    assert.equal(status.inVoice, false);
    assert.equal(typeof status.musicVolume, 'number');
  });
});

describe('spotify routes', () => {
  test('status', async () => {
    const res = await api('GET', '/api/spotify/status');
    assert.deepEqual(res.body, { configured: true, connected: true, canConnect: false, playlists: true });
  });

  test('search: empty query short-circuits, errors become a generic 502', async () => {
    assert.deepEqual((await api('GET', '/api/spotify/search?q=%20')).body, []);
    assert.equal(fake.callsTo('GET', '/search').length, 0);
    const res = await api('GET', '/api/spotify/search?q=track%201');
    assert.equal(res.body[0].name, 'Track 1');
    fake.fail('GET', '/search', 500, { times: 2 });
    const failed = await api('GET', '/api/spotify/search?q=x');
    assertErrorShape(failed, 502);
    assert.equal(failed.body.error, 'Spotify request failed');
  });

  test('track URIs are validated everywhere', async () => {
    for (const uri of ['', 'spotify:track:short', 'spotify:album:T000000000000000000001', `${trackUri(1)}x`, 'spotify:track:../../me/player0000']) {
      assertErrorShape(await api('POST', '/api/spotify/play', { json: { uri } }), 400);
      assertErrorShape(await api('POST', '/api/spotify/queue', { json: { uri } }), 400);
    }
  });

  test('play, queue, controls', async () => {
    assert.equal((await api('POST', '/api/spotify/play', { json: { uri: trackUri(1) } })).status, 200);
    const q = await api('POST', '/api/spotify/queue', { json: { uri: trackUri(2) } });
    assert.equal(q.status, 201);
    assert.equal(q.body.track.name, 'Track 2');
    assert.equal((await api('GET', '/api/spotify/queue')).body.length, 1);
    assertErrorShape(await api('DELETE', '/api/spotify/queue/abc'), 404);
    assert.equal((await api('DELETE', `/api/spotify/queue/${q.body.id}`)).status, 200);
    for (const action of ['pause', 'resume', 'next', 'previous']) {
      assert.equal((await api('POST', `/api/spotify/${action}`)).status, 200, action);
    }
  });

  test('Spotify’s own reason is surfaced for 403s; a missing speaker is a 409', async () => {
    fake.fail('PUT', '/me/player/play', 403, { body: { error: { status: 403, message: 'Restriction violated' } } });
    const res = await api('POST', '/api/spotify/resume');
    assertErrorShape(res, 403);
    assert.equal(res.body.error, 'Spotify: Restriction violated');

    fake.deviceOnline = false;
    fake.deviceId = 'device-gone'; // force re-resolution
    const missing = await api('POST', '/api/spotify/pause');
    assertErrorShape(missing, 409);
    fake.deviceOnline = true;
    fake.deviceId = 'device-1';
  });

  test('music volume', async () => {
    assertErrorShape(await api('POST', '/api/spotify/volume', { json: { value: 'loud' } }), 400);
    assert.deepEqual((await api('POST', '/api/spotify/volume', { json: { value: 250 } })).body, { ok: true, value: 100 });
    assert.deepEqual((await api('POST', '/api/spotify/volume', { json: { value: 37.4 } })).body, { ok: true, value: 37 });
  });

  test('playlists over HTTP', async () => {
    assertErrorShape(await api('POST', '/api/spotify/playlists', { json: {} }), 400);
    const created = await api('POST', '/api/spotify/playlists', { json: { name: ' Road trip ', emoji: '🚗', tags: 'Drive, drive', shuffle: 1 } });
    assert.equal(created.status, 201);
    const p = created.body;
    assert.equal(p.name, 'Road trip');
    assert.deepEqual(p.tags, ['drive']);
    assert.equal(p.shuffle, true);

    assertErrorShape(await api('PATCH', `/api/spotify/playlists/${p.id}`, { json: {} }), 400);
    assertErrorShape(await api('PATCH', `/api/spotify/playlists/${p.id}`, { json: { name: '' } }), 400);
    assertErrorShape(await api('PATCH', '/api/spotify/playlists/9999', { json: { shuffle: true } }), 404);

    assertErrorShape(await api('POST', `/api/spotify/playlists/${p.id}/play`), 400); // empty
    assertErrorShape(await api('POST', `/api/spotify/playlists/${p.id}/tracks`, { json: { uri: 'nope' } }), 400);
    assert.equal((await api('POST', `/api/spotify/playlists/${p.id}/tracks`, { json: { uri: trackUri(3) } })).status, 201);
    const dup = await api('POST', `/api/spotify/playlists/${p.id}/tracks`, { json: { uri: trackUri(3) } });
    assertErrorShape(dup, 409);
    assert.equal(dup.body.error, 'Already in this playlist');
    assert.equal((await api('GET', `/api/spotify/playlists/${p.id}/tracks?fresh=1`)).body.length, 1);
    assert.equal((await api('POST', `/api/spotify/playlists/${p.id}/play`)).status, 200);
    assert.equal((await api('DELETE', `/api/spotify/playlists/${p.id}/tracks`, { json: { uri: trackUri(3) } })).status, 200);
    assert.equal((await api('DELETE', `/api/spotify/playlists/${p.id}`)).status, 204);
    assert.equal((await api('GET', '/api/spotify/playlists')).body.some((x) => x.id === p.id), false);
  });

  test('the account-link callback rejects a forged state', async () => {
    const res = await fetch(`${base}/api/spotify/callback?code=c&state=forged`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /spotify=error/);
    assert.equal(fake.tokenRequests.filter((r) => r.grant_type === 'authorization_code').length, 0);
  });
});

describe('errors, CORS and headers', () => {
  test('malformed JSON is a 400, not a 500', async () => {
    assertErrorShape(await api('POST', '/api/spotify/volume', { json: '{"value": ' }), 400);
  });

  test('an oversized JSON body is a 413', async () => {
    assertErrorShape(await api('POST', '/api/spotify/volume', { json: { value: 1, pad: 'x'.repeat(70_000) } }), 413);
  });

  test('CORS: unknown origins are refused, the dev origin is allowed', async () => {
    const evil = await api('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assertErrorShape(evil, 403);
    const ok = await api('GET', '/api/health', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('security headers from helmet', async () => {
    const res = await api('GET', '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('rate limits (run last: they exhaust the buckets)', () => {
  async function exhaust(method, urlPath, limit, opts) {
    let res;
    for (let i = 0; i <= limit; i++) {
      res = await api(method, urlPath, opts);
      if (res.status === 429) break;
    }
    assert.equal(res.status, 429, `${urlPath} limited`);
    assert.equal(res.headers.get('ratelimit-limit') ?? res.headers.get('ratelimit-policy')?.split(';')[0], String(limit));
  }

  test('plays: 60/min', () => exhaust('POST', '/api/play/1', 60));
  test('uploads: 20/hour (counts only POSTs)', async () => {
    await exhaust('POST', '/api/clips', 20, { form: new FormData() });
    assert.equal((await api('GET', '/api/clips')).status, 200, 'listing is not limited');
  });
  test('spotify: 150/min', () => exhaust('GET', '/api/spotify/queue', 150));
});

test('no unhandled promise rejections', () => {
  assert.deepEqual(unhandled.map(String), []);
});
