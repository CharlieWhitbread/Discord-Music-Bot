'use strict';

const { setupEnv, freshRequire, flush, advance, captureConsole } = require('./helpers/env');
const { FakeSpotify, FULL_SCOPE } = require('./helpers/fakeSpotify');

const dataDir = setupEnv({
  SPOTIFY_CLIENT_ID: 'sp-client',
  SPOTIFY_CLIENT_SECRET: 'sp-secret',
  PUBLIC_API_URL: 'https://api.test',
}, { spotifyAuth: { refreshToken: 'refresh-0', scope: FULL_SCOPE } });

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tokenFile = path.join(dataDir, 'spotify-auth.json');
let fake;
let spotify;
let logs;

function load(auth = { refreshToken: 'refresh-0', scope: FULL_SCOPE }) {
  if (auth) fs.writeFileSync(tokenFile, JSON.stringify(auth));
  else fs.rmSync(tokenFile, { force: true });
  spotify = freshRequire('server/spotify.js');
  return spotify;
}

beforeEach((t) => {
  logs = captureConsole(t);
  fake = new FakeSpotify().install();
  fake.addTracks(5);
  load();
});

afterEach(() => {
  fake.uninstall();
  mock.timers.reset();
});

describe('Web API client', () => {
  test('player commands succeed on empty 202/204 bodies', async () => {
    const [a, b] = [...fake.catalog.values()].map((t) => t.uri);
    await spotify.playUris([a]);
    await spotify.queueUri(b);
    await spotify.setShuffle(true);
    await spotify.pause();
    await spotify.resume();
    await spotify.next();
    await spotify.previous();
    assert.equal(fake.state().current, b);
    assert.equal(fake.shuffle, true);
  });

  test('refreshes the access token once and reuses it', async () => {
    await spotify.search('track');
    await spotify.search('track');
    assert.equal(fake.tokenRequests.length, 1);
    assert.equal(fake.tokenRequests[0].grant_type, 'refresh_token');
    assert.equal(fake.tokenRequests[0].refresh_token, 'refresh-0');
  });

  test('401: refreshes the token and retries exactly once', async () => {
    await spotify.search('track');
    fake.revokeAccessToken();
    const results = await spotify.search('track 1');
    assert.equal(results[0].name, 'Track 1');
    assert.equal(fake.tokenRequests.length, 2);

    fake.fail('GET', '/search', 401, { times: 5 });
    const before = fake.callsTo('GET', '/search').length;
    await assert.rejects(spotify.search('x'), (err) => err.status === 401);
    assert.equal(fake.callsTo('GET', '/search').length, before + 2, 'one retry, not a loop');
  });

  test('429 with a short Retry-After waits and retries once', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    fake.fail('GET', '/search', 429, { headers: { 'Retry-After': '2' } });
    let done = false;
    const p = spotify.search('track').then((r) => { done = true; return r; });
    await advance(mock.timers, 1900);
    assert.equal(done, false, 'still waiting out Retry-After');
    await advance(mock.timers, 200);
    assert.equal((await p).length, 5);
    assert.equal(fake.callsTo('GET', '/search').length, 2);
  });

  test('429 with a long Retry-After fails fast', async () => {
    fake.fail('GET', '/search', 429, { headers: { 'Retry-After': '30' } });
    await assert.rejects(spotify.search('track'), (err) => err.status === 429);
    assert.equal(fake.callsTo('GET', '/search').length, 1);
  });

  test('5xx is retried for GET/PUT but never for POST (a retried /next skips twice)', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const uris = [...fake.catalog.values()].map((t) => t.uri);
    const run = async (promise) => {
      const settled = promise.then((value) => value ?? 'ok', (err) => err);
      await advance(mock.timers, 1000);
      return settled;
    };

    fake.fail('GET', '/search', 503);
    assert.equal((await run(spotify.search('track'))).length, 5);

    fake.fail('PUT', '/me/player/play', 502);
    assert.equal(await run(spotify.playUris(uris)), 'ok');
    assert.equal(fake.callsTo('PUT', '/me/player/play').length, 2);

    fake.fail('POST', '/me/player/next', 500);
    const err = await run(spotify.next());
    assert.equal(err.status, 500);
    assert.equal(fake.callsTo('POST', '/me/player/next').length, 1, 'POST not retried');
    assert.equal(fake.state().current, uris[0], 'did not skip');

    fake.fail('POST', '/me/player/queue', 500);
    assert.equal((await run(spotify.queueUri(uris[1]))).status, 500);
    assert.equal(fake.nativeQueue.length, 0);
  });

  test('error responses carry Spotify’s message in err.detail', async () => {
    fake.fail('PUT', '/me/player/play', 403, { body: { error: { status: 403, message: 'Restriction violated' } } });
    await assert.rejects(spotify.resume(), (err) => err.status === 403 && err.detail === 'Restriction violated');
  });

  test('a missing speaker is a 409 with a helpful message', async () => {
    fake.deviceOnline = false;
    await assert.rejects(spotify.pause(), (err) => err.status === 409 && /not found/.test(err.message));
  });

  test('a stale device id (404) is re-resolved once', async () => {
    await spotify.playUris([fake.catalog.values().next().value.uri]);
    fake.deviceId = 'device-2'; // librespot restarted → new Connect id
    await spotify.pause();
    assert.equal(fake.callsTo('GET', '/me/player/devices').length, 2);
    assert.equal(fake.state().isPlaying, false);
  });

  test('getTrack maps the authoritative metadata', async () => {
    const t = await spotify.getTrack(fake.catalog.keys().next().value);
    assert.deepEqual(Object.keys(t).sort(), ['album', 'artists', 'durationMs', 'image', 'name', 'uri']);
    assert.equal(t.image, 'https://img/1/64', 'smallest image');
  });

  test('getPlaylistTracks paginates and skips non-track items', async () => {
    const uris = fake.addTracks(120, { startAt: 100 });
    const id = fake.seedPlaylist('Big', uris);
    const tracks = await spotify.getPlaylistTracks(id);
    assert.equal(tracks.length, 120);
    assert.equal(fake.callsTo('GET', `/playlists/${id}/items`).length, 3);

    const mixed = fake.seedPlaylist('Mixed', []);
    fake.fail('GET', `/playlists/${mixed}/items`, 200, {
      body: { items: [{ track: fake.trackUri(uris[0]) }, { item: { uri: 'spotify:episode:x' } }, null, {}], next: null },
    });
    const filtered = await spotify.getPlaylistTracks(mixed);
    assert.deepEqual(filtered.map((t) => t.uri), [uris[0]], 'legacy "track" key accepted, episodes dropped');
  });

  test('concurrent first calls share one token refresh', async () => {
    await Promise.all([spotify.search('a'), spotify.search('b'), spotify.fetchNowPlaying()]);
    assert.equal(fake.tokenRequests.length, 1);
  });
});

describe('now playing', () => {
  test('idle player (204) → inactive', async () => {
    const np = await spotify.fetchNowPlaying();
    assert.equal(np.active, false);
  });

  test('maps state and reuses a fresh result with maxAgeMs', async () => {
    const uri = fake.catalog.values().next().value.uri;
    await spotify.playUris([uri]);
    await new Promise((r) => setTimeout(r, 2)); // results must be requested after the command
    const np = await spotify.fetchNowPlaying();
    assert.equal(np.track.uri, uri);
    assert.equal(np.onOurDevice, true);
    assert.equal(np.isPlaying, true);
    const before = fake.callsTo('GET', '/me/player').length;
    assert.equal(await spotify.fetchNowPlaying({ maxAgeMs: 5000 }), np);
    assert.equal(fake.callsTo('GET', '/me/player').length, before);
  });

  test('a command invalidates the cache', async () => {
    await spotify.playUris([fake.catalog.values().next().value.uri]);
    await spotify.fetchNowPlaying();
    await spotify.pause();
    const np = await spotify.fetchNowPlaying({ maxAgeMs: 60_000 });
    assert.equal(np.isPlaying, false, 'never served from before the pause');
  });

  test('concurrent callers share one in-flight request', async () => {
    await spotify.playUris([fake.catalog.values().next().value.uri]);
    await new Promise((r) => setTimeout(r, 2)); // requestedAt must be after the command
    const before = fake.callsTo('GET', '/me/player').length;
    const [a, b] = await Promise.all([spotify.fetchNowPlaying(), spotify.fetchNowPlaying()]);
    assert.equal(a, b);
    assert.equal(fake.callsTo('GET', '/me/player').length, before + 1);
  });

  /** Hold GET /me/player responses until released, to force reordering. */
  function gateNowPlaying() {
    const gates = [];
    globalThis.fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (String(input).includes('/me/player') && !String(input).includes('/devices') && (init?.method ?? 'GET') === 'GET') {
        await new Promise((resolve) => gates.push(resolve));
      }
      return res;
    };
    return gates;
  }

  test('an older response finishing late never overwrites a newer one', async () => {
    const [a, b] = [...fake.catalog.values()].map((t) => t.uri);
    await spotify.playUris([a]);
    await new Promise((r) => setTimeout(r, 2));
    const gates = gateNowPlaying();
    const old = spotify.fetchNowPlaying(); // sees track a, held
    await flush();
    await spotify.playUris([b]); // command → the held request is stale
    await new Promise((r) => setTimeout(r, 2));
    const fresh = spotify.fetchNowPlaying(); // sees track b
    await flush();
    gates[1](); // newer finishes first
    assert.equal((await fresh).track.uri, b);
    gates[0](); // then the old one
    await old;
    assert.equal(spotify.getLastNowPlaying().track.uri, b);
  });

  test('a response requested before a command is not published', async () => {
    const [a, b] = [...fake.catalog.values()].map((t) => t.uri);
    await spotify.playUris([a]);
    await new Promise((r) => setTimeout(r, 2));
    await spotify.fetchNowPlaying();
    const published = [];
    spotify.events.on('nowplaying', (np) => published.push(np.track?.uri));
    const gates = gateNowPlaying();
    const old = spotify.fetchNowPlaying(); // requested while `a` plays, held
    await flush();
    await spotify.playUris([b]);
    gates[0]();
    await old;
    assert.deepEqual(published, [], 'pre-command state would flip every client back to the old track');
  });
});

describe('account linking', () => {
  test('not configured / not connected', () => {
    load(null);
    assert.equal(spotify.configured(), true);
    assert.equal(spotify.connected(), false);
  });

  test('OAuth state is single-use and expires after 10 minutes', async () => {
    load(null);
    mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
    const state = new URL(spotify.loginUrl()).searchParams.get('state');
    await assert.rejects(spotify.handleCallback('code', 'forged'), /Invalid or expired state/);
    mock.timers.tick(10 * 60 * 1000 + 1);
    await assert.rejects(spotify.handleCallback('code', state), /Invalid or expired state/);

    const fresh = new URL(spotify.loginUrl()).searchParams.get('state');
    await spotify.handleCallback('code', fresh);
    assert.equal(spotify.connected(), true);
    const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    assert.equal(saved.refreshToken, 'refresh-1');
    assert.equal(saved.scope, FULL_SCOPE);
    await assert.rejects(spotify.handleCallback('code', fresh), /Invalid or expired state/, 'single use');
  });

  test('login URL asks for the playlist scopes', () => {
    const scope = new URL(spotify.loginUrl()).searchParams.get('scope');
    for (const s of ['playlist-modify-private', 'user-library-modify']) assert.ok(scope.includes(s));
  });

  test('a token linked before playlists existed: scope learned on first refresh', async () => {
    load({ refreshToken: 'old' }); // no scope recorded
    fake.scope = 'user-read-playback-state user-modify-playback-state';
    assert.equal(await spotify.hasPlaylistAccess(), false);
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).scope, fake.scope);

    load({ refreshToken: 'old' });
    fake.scope = FULL_SCOPE;
    assert.equal(await spotify.hasPlaylistAccess(), true);
  });

  test('a rotated refresh token is persisted', async () => {
    fake.rotateRefreshToken = true;
    await spotify.search('x');
    assert.match(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken, /^rotated-/);
  });
});

describe('stale reads after a command (measured live: up to ~0.35 s)', () => {
  /**
   * Make GET /me/player answer with the state from just before the last
   * player command for `lagMs`, like the real API does.
   */
  function laggingReads(lagMs) {
    let snapshot = null;
    let commandAt = -Infinity;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const isPlayerUrl = /\/v1\/me\/player(\/(play|pause|next|previous|shuffle))?(\?|$)/.test(url);
      if (isPlayerUrl && method === 'GET' && snapshot && Date.now() - commandAt < lagMs) {
        return new Response(snapshot.body, { status: snapshot.status, headers: { 'content-type': 'application/json' } });
      }
      if (isPlayerUrl && method !== 'GET') {
        const before = await fake.fetch('https://api.spotify.com/v1/me/player', { headers: init.headers });
        snapshot = { status: before.status, body: before.status === 204 ? null : await before.text() };
        const res = await fake.fetch(input, init);
        commandAt = Date.now();
        return res;
      }
      return fake.fetch(input, init);
    };
  }

  async function playingAndPublished() {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 20_000_000 });
    await spotify.playUris([fake.catalog.values().next().value.uri]);
    await advance(mock.timers, 2000);
    await spotify.fetchNowPlaying();
    assert.equal(spotify.getLastNowPlaying().isPlaying, true);
    const published = [];
    spotify.events.on('nowplaying', (np) => published.push(np.active ? np.isPlaying : 'inactive'));
    return published;
  }

  test('a stale "still playing" right after pause is not published; the follow-up refresh is', async () => {
    const published = await playingAndPublished();
    laggingReads(350);
    await spotify.pause();
    await advance(mock.timers, 100, 50);
    const stale = await spotify.fetchNowPlaying();
    assert.equal(stale.isPlaying, true, 'Spotify still answers "playing"');
    assert.deepEqual(published, [], 'not pushed to the website');
    await advance(mock.timers, 1600, 50); // the 600 ms and 1500 ms refreshes
    assert.ok(published.length > 0 && !published.includes(true), `published ${JSON.stringify(published)}`);
    assert.equal(spotify.getLastNowPlaying().isPlaying, false);
  });

  test('the same for resume, next and shuffle', async () => {
    const published = await playingAndPublished();
    await spotify.pause();
    await advance(mock.timers, 2000);
    laggingReads(350);
    published.length = 0;

    await spotify.resume();
    await advance(mock.timers, 100);
    await spotify.fetchNowPlaying();
    assert.deepEqual(published, [], 'stale "paused" not published');
    await advance(mock.timers, 1600);
    assert.equal(published.at(-1), true);

    const uris = [];
    spotify.events.on('nowplaying', (np) => uris.push(np.track?.uri));
    const before = spotify.getLastNowPlaying().track.uri;
    await spotify.playUris([...fake.catalog.values()].slice(0, 3).map((t) => t.uri));
    await advance(mock.timers, 2000);
    uris.length = 0;
    await spotify.next();
    await advance(mock.timers, 100);
    await spotify.fetchNowPlaying();
    assert.ok(!uris.includes(before), 'old track not re-published after next');
    await advance(mock.timers, 1600);
    assert.notEqual(spotify.getLastNowPlaying().track.uri, before);

    const shuffles = [];
    spotify.events.on('nowplaying', (np) => shuffles.push(np.shuffle));
    await spotify.setShuffle(true);
    await advance(mock.timers, 100);
    await spotify.fetchNowPlaying();
    assert.ok(!shuffles.includes(false), 'stale shuffle=false not published');
    await advance(mock.timers, 1600);
    assert.equal(spotify.getLastNowPlaying().shuffle, true);
  });

  test('a read already showing the outcome is published straight away', async () => {
    const published = await playingAndPublished();
    await spotify.pause(); // no lag
    await advance(mock.timers, 50, 10);
    await spotify.fetchNowPlaying();
    assert.equal(published[0], false, 'published before any refresh timer');
  });

  test('if the command never takes effect, the real state still lands after the window', async () => {
    const published = await playingAndPublished();
    fake.fail('PUT', '/me/player/pause', 204, {}); // "succeeds" but does nothing
    await spotify.pause();
    await advance(mock.timers, 1600, 50);
    assert.equal(published.at(-1), true, 'website shows the truth: still playing');
  });
});

describe('logExternalChanges', () => {
  async function playing() {
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000_000 });
    await spotify.playUris([fake.catalog.values().next().value.uri]);
    await advance(mock.timers, 6000, 500);
    await spotify.fetchNowPlaying();
    logs.warn.length = 0;
  }

  test('warns when paused outside the bot mid-track', async () => {
    await playing();
    fake.state().isPlaying = false;
    await spotify.fetchNowPlaying();
    assert.ok(logs.warn.some((l) => /paused outside the bot/.test(l)));
  });

  test('does not warn for the bot’s own pause', async () => {
    await playing();
    await spotify.pause();
    await advance(mock.timers, 500);
    await spotify.fetchNowPlaying();
    assert.deepEqual(logs.warn, []);
  });

  test('warns when a track is cut short by something other than the bot', async () => {
    await playing();
    const other = [...fake.catalog.values()][2].uri;
    fake.start({ uris: [other] }); // e.g. ⏭ in the Spotify app
    await spotify.fetchNowPlaying();
    assert.ok(logs.warn.some((l) => /cut short with ~\d+s left/.test(l) && /not by the bot/.test(l)), logs.warn.join('\n'));
  });

  test('does not warn for the bot’s own skip', async () => {
    await playing();
    const uris = [...fake.catalog.values()].slice(0, 3).map((t) => t.uri);
    await spotify.playUris(uris);
    await advance(mock.timers, 6000, 500);
    await spotify.fetchNowPlaying();
    logs.warn.length = 0;
    await spotify.next();
    await advance(mock.timers, 2000);
    await spotify.fetchNowPlaying();
    assert.deepEqual(logs.warn, []);
  });

  test('does not warn when the track simply ran out', async () => {
    await playing();
    fake.seekTo(29_000);
    await spotify.fetchNowPlaying();
    await advance(mock.timers, 2000, 500); // ends, nothing after → paused
    await spotify.fetchNowPlaying();
    assert.deepEqual(logs.warn, []);
  });

  test('warns when playback moves to another device or stops', async () => {
    await playing();
    fake.moveToOtherDevice('Phone');
    await spotify.fetchNowPlaying();
    assert.ok(logs.warn.some((l) => /moved to another device \("Phone"\)/.test(l)));

    await playing();
    fake.player = null;
    await spotify.fetchNowPlaying();
    assert.ok(logs.warn.some((l) => /no active device/.test(l)));
  });
});
