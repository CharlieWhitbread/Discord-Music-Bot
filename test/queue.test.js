'use strict';

const { setupEnv, freshRequire, advance, captureConsole } = require('./helpers/env');
const { FakeSpotify, FULL_SCOPE } = require('./helpers/fakeSpotify');

setupEnv({
  SPOTIFY_CLIENT_ID: 'sp-client',
  SPOTIFY_CLIENT_SECRET: 'sp-secret',
  PUBLIC_API_URL: 'https://api.test',
}, { spotifyAuth: { refreshToken: 'refresh-0', scope: FULL_SCOPE } });

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const TRACK_MS = 60_000;
const user = { userId: 'u1', username: 'Alice' };

let fake;
let spotify;
let queue;
let uris;
let logs;

beforeEach((t) => {
  logs = captureConsole(t);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000 });
  fake = new FakeSpotify().install();
  uris = fake.addTracks(10, { durationMs: TRACK_MS });
  spotify = freshRequire('server/spotify.js');
  queue = freshRequire('server/queue.js');
});

afterEach(() => {
  fake.uninstall();
  mock.timers.reset();
});

const run = (ms) => advance(mock.timers, ms, 100);
const now = () => fake.state()?.current;
const queuedUris = () => queue.list().map((e) => e.track.uri);

/** Start a 3-track playlist context (P1..P3 = uris[0..2]). */
async function playPlaylist() {
  const id = fake.seedPlaylist('Ctx', uris.slice(0, 3));
  await spotify.playContext(`spotify:playlist:${id}`, 0);
  return id;
}

describe('adding', () => {
  test('starts the song directly when nothing is playing', async () => {
    await queue.add(uris[5], user);
    await run(500);
    assert.equal(now(), uris[5]);
    assert.deepEqual(queue.list(), []);
  });

  test('entries get unique ids, keep order and carry server-side metadata', async () => {
    await playPlaylist();
    const [a, b] = await Promise.all([queue.add(uris[5], user), queue.add(uris[6], user)]);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(queuedUris(), [uris[5], uris[6]]);
    assert.equal(a.track.name, 'Track 6');
    assert.deepEqual(a.addedBy, { userId: 'u1', username: 'Alice' });
  });

  test('an unknown track is rejected and nothing is queued', async () => {
    await assert.rejects(queue.add('spotify:track:TXXXXXXXXXXXXXXXXXXXXX', user), (e) => e.status === 404);
    assert.deepEqual(queue.list(), []);
  });

  test('emits update events', async () => {
    const updates = [];
    queue.events.on('update', (l) => updates.push(l.length));
    await playPlaylist();
    const e = await queue.add(uris[5], user);
    queue.remove(e.id);
    assert.deepEqual(updates, [1, 0]);
  });
});

describe('handover to Spotify’s native queue', () => {
  test('hands over ~15 s before the end, so the playlist context survives', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    await run(44_000);
    assert.deepEqual(fake.nativeQueue, [], 'not yet — 16 s left');
    await run(2_000);
    assert.deepEqual(fake.nativeQueue, [uris[5]], 'handed over inside the last 15 s');
    assert.equal(queue.list()[0].locked, true);

    await run(15_000); // P1 ends → our song
    assert.equal(now(), uris[5]);
    assert.deepEqual(queue.list(), [], 'reconciled once Spotify plays it');
    assert.equal(fake.state().contextUri.startsWith('spotify:playlist:'), true);

    await run(TRACK_MS); // our song ends → the playlist carries on
    assert.equal(now(), uris[1]);
  });

  test('several queued songs are handed over one per track', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    await queue.add(uris[6], user);
    await run(61_000);
    assert.equal(now(), uris[5]);
    assert.deepEqual(fake.nativeQueue, []);
    await run(TRACK_MS);
    assert.equal(now(), uris[6]);
    await run(TRACK_MS);
    assert.equal(now(), uris[1]);
    assert.equal(queue.hasItems(), false);
  });

  test('a handed-over (locked) entry cannot be removed; pending ones can', async () => {
    await playPlaylist();
    const a = await queue.add(uris[5], user);
    const b = await queue.add(uris[6], user);
    fake.seekTo(TRACK_MS - 10_000);
    await run(1_000);
    assert.equal(queue.remove(a.id), 'locked');
    assert.equal(queue.remove(b.id), 'removed');
    assert.equal(queue.remove(b.id), 'missing');
  });

  test('a failed handover puts the entry back at the front and retries', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    await queue.add(uris[6], user);
    fake.seekTo(TRACK_MS - 14_000);
    fake.fail('POST', '/me/player/queue', 500);
    await run(500);
    assert.deepEqual(queuedUris(), [uris[5], uris[6]]);
    assert.equal(queue.list()[0].locked, undefined);
    await run(10_500); // RETRY_MS later there are still ~3 s left
    assert.deepEqual(fake.nativeQueue, [uris[5]]);
    await run(4_000);
    assert.equal(now(), uris[5]);
  });

  test('a failed handover inside the last 10 s plays one track late in a playlist', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    fake.seekTo(TRACK_MS - 8_000);
    fake.fail('POST', '/me/player/queue', 500);
    await run(TRACK_MS + 10_000); // P1's last 8 s + all of P2
    assert.equal(fake.state().index, 1, 'P2 played before the queued song');
    assert.equal(now(), uris[5]);
  });

  test('a handed-over song that never plays is dropped after 2 track changes', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    fake.seekTo(TRACK_MS - 10_000);
    await run(500);
    assert.equal(queue.list()[0].locked, true);
    fake.nativeQueue.length = 0; // cleared in the Spotify app
    await run(11_000); // P1 → P2 (change 1)
    assert.equal(queue.list().length, 1, 'one change could be a user skip');
    await run(TRACK_MS); // P2 → P3 (change 2)
    assert.deepEqual(queue.list(), []);
    assert.ok(logs.warn.some((l) => /never played — dropping/.test(l)));
  });
});

describe('skip / play now', () => {
  test('skip with a handed-over song plays it next', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    fake.seekTo(TRACK_MS - 10_000);
    await run(500);
    const p = queue.skip();
    await run(500);
    await p;
    assert.equal(now(), uris[5]);
    await run(2_000);
    assert.deepEqual(queue.list(), []);
  });

  test('skip with pending songs jumps to the first one and keeps the context', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    await queue.add(uris[6], user);
    const p = queue.skip();
    await run(1_000);
    await p;
    assert.equal(now(), uris[5]);
    assert.deepEqual(queuedUris(), [uris[6]]);
    assert.equal(fake.state().index, 0, 'context position untouched');
  });

  test('skip with an empty queue just skips', async () => {
    await playPlaylist();
    const p = queue.skip();
    await run(500);
    await p;
    assert.equal(now(), uris[1]);
  });

  test('skip with nothing active starts the first queued song', async () => {
    await queue.add(uris[5], user);
    fake.player = null; // nothing on the account (watcher hasn't run yet)
    const p = queue.skip();
    await run(500);
    await p;
    assert.equal(now(), uris[5]);
  });

  test('play now without a context replaces playback directly', async () => {
    await spotify.playUris([uris[0]]);
    const p = queue.playNow(uris[7]);
    await run(500);
    await p;
    assert.equal(now(), uris[7]);
    assert.equal(fake.callsTo('POST', '/me/player/queue').length, 0);
  });

  test('play now in a playlist jumps via the native queue and the playlist resumes after', async () => {
    await playPlaylist();
    const p = queue.playNow(uris[7]);
    await run(1_000);
    await p;
    assert.equal(now(), uris[7]);
    await run(TRACK_MS);
    assert.equal(now(), uris[1], 'context resumed');
  });

  test('play now with a handed-over song pending skips past it and re-queues it', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    fake.seekTo(TRACK_MS - 10_000);
    await run(500);
    assert.equal(queue.list()[0].locked, true);
    const p = queue.playNow(uris[7]);
    await run(1_500);
    await p;
    assert.equal(now(), uris[7]);
    assert.deepEqual(queuedUris(), [uris[5]]);
    assert.equal(queue.list()[0].locked, undefined, 'back to pending, will be handed over again');
  });

  test('play now when the handed-over song vanished from Spotify’s queue', {
    todo: 'KNOWN ISSUE: the extra /next skips the requested song too (needs GET /me/player/queue to verify)',
  }, async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    fake.seekTo(TRACK_MS - 10_000);
    await run(500);
    fake.nativeQueue.length = 0; // user cleared the queue in the Spotify app
    const p = queue.playNow(uris[7]);
    await run(1_500);
    await p;
    assert.equal(now(), uris[7]);
  });

  test('watcher ticks never interleave with play-now’s queue+next sequence', async () => {
    await playPlaylist();
    await queue.add(uris[5], user);
    await queue.add(uris[6], user);
    fake.seekTo(TRACK_MS - 15_500); // the handover tick is due right now
    const ops = [queue.playNow(uris[7]), queue.skip()];
    await run(5_000);
    await Promise.all(ops);
    const seq = fake.calls
      .filter((c) => c.method === 'POST')
      .map((c) => `${c.path.split('/').pop()}${c.query.uri ? `:${uris.indexOf(c.query.uri)}` : ''}`);
    // every queue POST from play-now is immediately followed by its /next
    const i = seq.indexOf('queue:7');
    assert.equal(seq[i + 1], 'next', `sequence: ${seq.join(' ')}`);
  });
});

describe('the watcher', () => {
  test('starts the next song after a single-track context ends', async () => {
    await spotify.playUris([uris[0]]);
    await queue.add(uris[5], user);
    await run(TRACK_MS + 6_000);
    assert.equal(now(), uris[5]);
  });

  test('a user pause mid-track is not mistaken for the track ending', async () => {
    await spotify.playUris([uris[0]]);
    await queue.add(uris[5], user);
    await run(20_000);
    await spotify.pause();
    await run(30_000);
    assert.equal(now(), uris[0]);
    assert.equal(fake.state().isPlaying, false);
    assert.deepEqual(queuedUris(), [uris[5]]);
  });

  test('queue survives a failed handover in the last 10 s of a single-track context', {
    todo: 'KNOWN ISSUE: the 10 s retry lands after the track ended; "ended" needs a poll in the final 4 s, so the queue stalls',
  }, async () => {
    await spotify.playUris([uris[0]]);
    fake.seekTo(TRACK_MS - 8_000);
    fake.fail('POST', '/me/player/queue', 500);
    await queue.add(uris[5], user);
    await run(30_000);
    assert.equal(now(), uris[5]);
  });

  test('bot not in voice: retries every 10 s without losing songs or crashing', async () => {
    fake.deviceOnline = false;
    await queue.add(uris[5], user);
    await run(61_000);
    const attempts = fake.callsTo('GET', '/me/player/devices').length;
    assert.ok(attempts >= 5 && attempts <= 8, `attempts=${attempts}`);
    assert.deepEqual(queuedUris(), [uris[5]]);
    assert.ok(logs.error.some((l) => /watcher error: .*not found/.test(l)));

    fake.deviceOnline = true; // /join
    await run(10_500);
    assert.equal(now(), uris[5]);
  });

  test('stops polling once the queue is empty', async () => {
    await playPlaylist();
    const e = await queue.add(uris[5], user);
    await run(1_000);
    queue.remove(e.id);
    await run(10_000);
    const before = fake.callsTo('GET', '/me/player').length;
    await run(60_000);
    assert.equal(fake.callsTo('GET', '/me/player').length, before);
  });
});
