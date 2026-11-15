'use strict';

const { setupEnv, freshRequire, flush, captureConsole } = require('./helpers/env');
const { FakeSpotify, FULL_SCOPE } = require('./helpers/fakeSpotify');

setupEnv({
  SPOTIFY_CLIENT_ID: 'sp-client',
  SPOTIFY_CLIENT_SECRET: 'sp-secret',
  PUBLIC_API_URL: 'https://api.test',
}, { spotifyAuth: { refreshToken: 'refresh-0', scope: FULL_SCOPE } });

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const alice = { userId: 'alice', username: 'Alice' };
const fields = (over = {}) => ({ name: 'Chill', emoji: '😎', tags: ['lofi'], shuffle: false, ...over });

let fake;
let spotify;
let playlists;
let uris;
let logs;

beforeEach((t) => {
  logs = captureConsole(t);
  fake = new FakeSpotify().install();
  uris = fake.addTracks(10);
  spotify = freshRequire('server/spotify.js');
  playlists = freshRequire('server/playlists.js');
});

afterEach(() => {
  fake.uninstall();
  mock.timers.reset();
});

const spotifyUris = (p) => fake.playlists.get(p.spotifyId).uris;
const settle = (promises) => Promise.allSettled(promises);

describe('create / update / remove', () => {
  test('creates a private Spotify playlist and the tile metadata', async () => {
    const updates = [];
    playlists.events.on('update', (l) => updates.push(l));
    const p = await playlists.create(fields(), alice);
    assert.equal(fake.callsTo('POST', '/me/playlists')[0].body.public, false);
    assert.equal(p.name, 'Chill');
    assert.deepEqual(p.tags, ['lofi']);
    assert.equal(p.creatorId, 'alice');
    assert.equal(updates.length, 1);
    assert.deepEqual(await playlists.getTracks(p.id), []);
    assert.equal(fake.callsTo('GET', /\/items$/).length, 0, 'fresh playlist served from cache');
  });

  test('rename is pushed to Spotify without blocking; a Spotify failure keeps the local edit', async () => {
    const p = await playlists.create(fields(), alice);
    fake.fail('PUT', `/playlists/${p.spotifyId}`, 500, { times: 2 });
    const updated = await playlists.update(p.id, { name: 'Focus' });
    assert.equal(updated.name, 'Focus');
    await new Promise((r) => setTimeout(r, 700)); // past the 5xx retry
    assert.ok(logs.error.some((l) => /rename on Spotify failed/.test(l)));
    await playlists.update(p.id, { name: 'Focus 2' });
    await flush();
    assert.equal(fake.playlists.get(p.spotifyId).name, 'Focus 2');
  });

  test('partial updates keep the other fields; empty tags clear them', async () => {
    const p = await playlists.create(fields(), alice);
    const u = await playlists.update(p.id, { tags: [] });
    assert.equal(u.name, 'Chill');
    assert.equal(u.emoji, '😎');
    assert.deepEqual(u.tags, []);
    const v = await playlists.update(p.id, { emoji: null });
    assert.equal(v.emoji, null);
  });

  test('toggling shuffle applies live only when this playlist is playing', async () => {
    const p = await playlists.create(fields(), alice);
    await playlists.addTrack(p.id, uris[0]);
    await playlists.update(p.id, { shuffle: true });
    assert.equal(fake.callsTo('PUT', '/me/player/shuffle').length, 0);

    await playlists.play(p.id);
    await new Promise((r) => setTimeout(r, 2));
    await spotify.fetchNowPlaying();
    await playlists.update(p.id, { shuffle: false });
    assert.equal(fake.callsTo('PUT', '/me/player/shuffle').at(-1).query.state, 'false');
  });

  test('deleting unfollows on Spotify; playback of it carries on', async () => {
    const p = await playlists.create(fields(), alice);
    await playlists.addTrack(p.id, uris[0]);
    await playlists.play(p.id);
    await playlists.remove(p.id);
    assert.equal(fake.playlists.get(p.spotifyId).followed, false);
    assert.equal(fake.callsTo('DELETE', '/me/library')[0].query.uris, `spotify:playlist:${p.spotifyId}`);
    assert.throws(() => playlists.get(p.id), (e) => e.status === 404);
    assert.equal(fake.state().isPlaying, true, 'the context keeps playing (accepted)');
  });

  test('a Spotify failure on delete still forgets it locally', async () => {
    const p = await playlists.create(fields(), alice);
    fake.fail('DELETE', '/me/library', 500);
    await playlists.remove(p.id);
    assert.ok(!playlists.list().some((x) => x.id === p.id));
  });

  test('unknown ids are 404', async () => {
    await assert.rejects(playlists.update(999, { name: 'x' }), (e) => e.status === 404);
    await assert.rejects(playlists.addTrack(999, uris[0]), (e) => e.status === 404);
    await assert.rejects(playlists.play(999), (e) => e.status === 404);
  });
});

describe('tracks', () => {
  test('add/remove keep Spotify, the cache and track_count in sync', async () => {
    const p = await playlists.create(fields(), alice);
    await playlists.addTrack(p.id, uris[0]);
    await playlists.addTrack(p.id, uris[1]);
    await playlists.removeTrack(p.id, uris[0]);
    assert.deepEqual(spotifyUris(p), [uris[1]]);
    assert.deepEqual((await playlists.getTracks(p.id)).map((t) => t.uri), [uris[1]]);
    assert.equal(playlists.get(p.id).trackCount, 1);
  });

  test('concurrent adds of the same song: one wins, the other is 409', async () => {
    const p = await playlists.create(fields(), alice);
    const results = await settle([playlists.addTrack(p.id, uris[0]), playlists.addTrack(p.id, uris[0])]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    assert.equal(results[1].reason.status, 409);
    assert.deepEqual(spotifyUris(p), [uris[0]]);
  });

  test('concurrent add/remove interleave safely under the per-playlist lock', async () => {
    const p = await playlists.create(fields(), alice);
    await settle([
      playlists.addTrack(p.id, uris[0]),
      playlists.addTrack(p.id, uris[1]),
      playlists.removeTrack(p.id, uris[0]),
      playlists.addTrack(p.id, uris[2]),
      playlists.addTrack(p.id, uris[1]),
    ]);
    assert.deepEqual(spotifyUris(p), [uris[1], uris[2]]);
    assert.deepEqual((await playlists.getTracks(p.id)).map((t) => t.uri), [uris[1], uris[2]]);
    assert.equal(playlists.get(p.id).trackCount, 2);
  });

  test('a failed operation does not wedge the lock', async () => {
    const p = await playlists.create(fields(), alice);
    fake.fail('POST', `/playlists/${p.spotifyId}/items`, 500);
    await assert.rejects(playlists.addTrack(p.id, uris[0]), (e) => e.status === 500);
    assert.deepEqual(await playlists.getTracks(p.id), [], 'cache untouched on failure');
    await playlists.addTrack(p.id, uris[0]);
    assert.deepEqual(spotifyUris(p), [uris[0]]);
  });

  test('removing a song that appears twice removes every copy', async () => {
    const p = await playlists.create(fields(), alice);
    fake.playlists.get(p.spotifyId).uris.push(uris[0], uris[1], uris[0]); // edited in the Spotify app
    const tracks = await playlists.getTracks(p.id, { fresh: true });
    assert.equal(tracks.length, 3);
    await playlists.removeTrack(p.id, uris[0]);
    assert.deepEqual(spotifyUris(p), [uris[1]]);
    assert.equal(playlists.get(p.id).trackCount, 1);
  });

  test('getTracks(fresh) picks up edits made in the Spotify app and syncs the count', async () => {
    const p = await playlists.create(fields(), alice);
    fake.playlists.get(p.spotifyId).uris.push(uris[3]);
    assert.deepEqual(await playlists.getTracks(p.id), [], 'cache still fresh');
    assert.equal((await playlists.getTracks(p.id, { fresh: true })).length, 1);
    assert.equal(playlists.get(p.id).trackCount, 1);
  });

  test('the cache expires after 10 minutes', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const p = await playlists.create(fields(), alice);
    fake.playlists.get(p.spotifyId).uris.push(uris[3]);
    mock.timers.tick(10 * 60 * 1000 + 1);
    assert.equal((await playlists.getTracks(p.id)).length, 1);
    await assert.rejects(playlists.addTrack(p.id, uris[3]), (e) => e.status === 409);
  });

  test('a song added in the Spotify app within the cache TTL is not duplicated', {
    todo: 'KNOWN ISSUE: the duplicate check uses a cache up to 10 min stale; adding re-adds it on Spotify',
  }, async () => {
    const p = await playlists.create(fields(), alice);
    fake.playlists.get(p.spotifyId).uris.push(uris[3]);
    await assert.rejects(playlists.addTrack(p.id, uris[3]), (e) => e.status === 409);
  });

  test('caps playlists at 500 songs', async () => {
    const many = fake.addTracks(500, { startAt: 1000 });
    const p = await playlists.create(fields(), alice);
    fake.playlists.get(p.spotifyId).uris.push(...many);
    await playlists.getTracks(p.id, { fresh: true });
    await assert.rejects(playlists.addTrack(p.id, uris[0]), (e) => e.status === 400 && /500/.test(e.message));
  });
});

describe('play', () => {
  test('an empty playlist is a 400', async () => {
    const p = await playlists.create(fields(), alice);
    await assert.rejects(playlists.play(p.id), (e) => e.status === 400);
  });

  test('plays as the context, applies shuffle and counts the play', async (t) => {
    const p = await playlists.create(fields({ shuffle: true }), alice);
    for (const uri of uris.slice(0, 4)) await playlists.addTrack(p.id, uri);
    t.mock.method(Math, 'random', () => 0.6);
    await playlists.play(p.id);
    const play = fake.callsTo('PUT', '/me/player/play').at(-1);
    assert.equal(play.body.context_uri, `spotify:playlist:${p.spotifyId}`);
    assert.equal(play.body.offset.position, 2, 'random start track when shuffled');
    assert.equal(fake.shuffle, true);
    assert.equal(playlists.get(p.id).playCount, 1);
  });

  test('a shuffle failure does not fail the play', async () => {
    const p = await playlists.create(fields(), alice);
    await playlists.addTrack(p.id, uris[0]);
    fake.fail('PUT', '/me/player/shuffle', 403, { times: 2 });
    await playlists.play(p.id);
    assert.equal(fake.state().isPlaying, true);
  });
});
