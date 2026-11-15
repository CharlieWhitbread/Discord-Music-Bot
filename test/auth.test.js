'use strict';

/**
 * Real auth (AUTH_DISABLED=false): Discord OAuth with a stubbed Discord
 * API, bearer tokens, the guild gate, creator/admin permissions, CORS and
 * the WebSocket protocol.
 */

const { setupEnv, captureConsole, flush } = require('./helpers/env');
const { freePort, startServer, call, openSocket } = require('./helpers/server');
const { FakeSpotify, json } = require('./helpers/fakeSpotify');

const { test, describe, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const WEB = 'https://web.test';
let srv;
let base;
let fake;
let db;
let auth;
let sessionManager;
let watch;
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

/* Discord stub: the OAuth code decides who logs in. */
const discordUsers = {
  alice: { user: { id: 'alice', username: 'alice', global_name: 'Alice', avatar: 'abc' }, guilds: [{ id: 'guild-1' }, { id: 'x' }] },
  outsider: { user: { id: 'eve', username: 'eve', avatar: null }, guilds: [{ id: 'other' }] },
};
const discordCalls = [];
async function discordFetch(url, init = {}) {
  discordCalls.push(url.pathname);
  if (url.pathname === '/api/v10/oauth2/token') {
    const code = new URLSearchParams(String(init.body)).get('code');
    return discordUsers[code] ? json(200, { access_token: `d-${code}` }) : json(400, { error: 'invalid_grant' });
  }
  const who = init.headers?.Authorization?.replace('Bearer d-', '');
  if (url.pathname === '/api/v10/users/@me') return json(200, discordUsers[who].user);
  if (url.pathname === '/api/v10/users/@me/guilds') return json(200, discordUsers[who].guilds);
  return json(404, {});
}

before(async () => {
  const port = await freePort();
  setupEnv({
    SOUNDBOARD_PORT: String(port),
    AUTH_DISABLED: 'false',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    PUBLIC_API_URL: 'https://api.test',
    WEB_ORIGIN: WEB,
    GUILD_ID: 'guild-1',
    ADMIN_USER_IDS: 'admin, other-admin',
    SPOTIFY_CLIENT_ID: 'sp-client',
    SPOTIFY_CLIENT_SECRET: 'sp-secret',
  }); // Spotify configured but not linked yet
  fake = new FakeSpotify().install();
  fake.addTracks(5);
  const spotifyFetch = fake.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    return url.hostname === 'discord.com' ? discordFetch(url, init) : spotifyFetch(input, init);
  };
  db = require('../src/server/db');
  auth = require('../src/server/auth');
  sessionManager = require('../src/audio/sessionManager');
  watch = require('../src/server/watch');
  srv = await startServer();
  base = srv.base;
  tokens.alice = mintToken('alice', 'Alice');
  tokens.bob = mintToken('bob', 'Bob');
  tokens.admin = mintToken('admin', 'Admin');
});

after(() => {
  srv?.stop();
  fake?.uninstall();
});

beforeEach((t) => {
  captureConsole(t);
});

function mintToken(userId, username = userId, ttlMs = 60_000) {
  const token = crypto.randomBytes(16).toString('hex');
  db.insertToken({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId, username, avatar: null, createdAt: Date.now(), expiresAt: Date.now() + ttlMs,
  });
  return token;
}

const api = (method, path, opts) => call(base, method, path, opts);
const redirect = (path) => fetch(`${base}${path}`, { redirect: 'manual' });
const tokens = {};

describe('bearer tokens', () => {
  test('missing, malformed, unknown and expired tokens are 401', async () => {
    const expired = mintToken('bob', 'Bob', -1);
    for (const headers of [{}, { Authorization: tokens.alice }, { Authorization: 'Basic abc' }, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${expired}` }]) {
      const res = await api('GET', '/api/auth/me', { headers });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: 'Not authenticated' });
    }
  });

  test('a valid token resolves to its user', async () => {
    const res = await api('GET', '/api/auth/me', { token: tokens.alice });
    assert.deepEqual(res.body, { userId: 'alice', username: 'Alice', avatar: null });
  });

  test('every API route requires auth', async () => {
    for (const [method, path] of [
      ['GET', '/api/clips'], ['POST', '/api/clips'], ['GET', '/api/clips/favorites'], ['PATCH', '/api/clips/1'],
      ['DELETE', '/api/clips/1'], ['GET', '/api/clips/1/audio'], ['POST', '/api/play/1'], ['POST', '/api/stop'],
      ['GET', '/api/status'], ['GET', '/api/spotify/status'], ['GET', '/api/spotify/search?q=a'],
      ['POST', '/api/spotify/pause'], ['POST', '/api/spotify/volume'], ['GET', '/api/spotify/queue'],
      ['GET', '/api/spotify/playlists'], ['DELETE', '/api/spotify/playlists/1'],
    ]) {
      assert.equal((await api(method, path)).status, 401, `${method} ${path}`);
    }
  });
});

describe('Discord OAuth', () => {
  async function startLogin() {
    const res = await redirect('/api/auth/login');
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location'));
    return url;
  }

  test('login redirects to Discord with a CSRF state', async () => {
    const url = await startLogin();
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(url.searchParams.get('scope'), 'identify guilds');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://api.test/api/auth/callback');
    assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
  });

  test('a guild member gets a token in the URL fragment; only its hash is stored', async () => {
    const state = (await startLogin()).searchParams.get('state');
    const res = await redirect(`/api/auth/callback?code=alice&state=${state}`);
    const location = res.headers.get('location');
    assert.match(location, new RegExp(`^${WEB}/#token=[0-9a-f]{64}$`));
    const token = location.split('#token=')[1];
    const me = (await api('GET', '/api/auth/me', { token })).body;
    assert.deepEqual(me, { userId: 'alice', username: 'Alice', avatar: 'https://cdn.discordapp.com/avatars/alice/abc.png?size=64' });
    const rows = db.db.prepare('SELECT token_hash FROM tokens').all();
    assert.ok(!rows.some((r) => r.token_hash === token), 'raw token never stored');

    const replay = await redirect(`/api/auth/callback?code=alice&state=${state}`);
    assert.match(replay.headers.get('location'), /#error=Invalid/, 'state is single-use');
  });

  test('non-members are refused', async () => {
    const before = db.db.prepare('SELECT COUNT(*) n FROM tokens').get().n;
    const state = (await startLogin()).searchParams.get('state');
    const res = await redirect(`/api/auth/callback?code=outsider&state=${state}`);
    assert.match(decodeURIComponent(res.headers.get('location')), /#error=You are not a member/);
    assert.equal(db.db.prepare('SELECT COUNT(*) n FROM tokens').get().n, before);
  });

  test('forged/missing state and failed code exchange redirect with an error', async () => {
    for (const qs of ['code=alice&state=forged', 'code=alice', 'state=x', '']) {
      const res = await redirect(`/api/auth/callback?${qs}`);
      assert.match(res.headers.get('location'), new RegExp(`^${WEB}/#error=`), qs);
    }
    const state = (await startLogin()).searchParams.get('state');
    const res = await redirect(`/api/auth/callback?code=bad&state=${state}`);
    assert.match(decodeURIComponent(res.headers.get('location')), /Login failed/);
  });

  test('a state expires after 10 minutes', async () => {
    const res = { redirect(url) { this.location = url; } };
    auth.login({}, res);
    const state = new URL(res.location).searchParams.get('state');
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60 * 1000 + 1 });
    try {
      const out = { redirect(url) { this.location = url; } };
      await auth.callback({ query: { code: 'alice', state } }, out);
      assert.match(out.location, /#error=Invalid/);
    } finally {
      mock.timers.reset();
    }
  });

  test('a successful login purges expired tokens', async () => {
    mintToken('ghost', 'Ghost', -1000);
    const state = (await startLogin()).searchParams.get('state');
    await redirect(`/api/auth/callback?code=alice&state=${state}`);
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM tokens WHERE user_id = 'ghost'").get().n, 0);
  });
});

describe('CORS allow-list', () => {
  for (const [origin, allowed] of [
    [WEB, true], ['http://localhost:5173', true], ['http://127.0.0.1:5173', true],
    ['https://web.test.evil.com', false], ['http://web.test', false], ['null', false], ['http://localhost:3000', false],
  ]) {
    test(`${origin} → ${allowed ? 'allowed' : 'refused'}`, async () => {
      const res = await api('GET', '/api/health', { headers: { Origin: origin } });
      if (allowed) assert.equal(res.headers.get('access-control-allow-origin'), origin);
      else assert.equal(res.status, 403);
    });
  }
});

describe('clip permissions (uploader or admin)', () => {
  let clipId;
  before(() => {
    clipId = db.insertClip({ name: 'Alice clip', durationMs: 1, uploaderId: 'alice', uploaderName: 'Alice', createdAt: 0 }).id;
  });

  test('others cannot edit or delete; anyone can favourite', async () => {
    assert.equal((await api('PATCH', `/api/clips/${clipId}`, { token: tokens.bob, json: { name: 'mine' } })).status, 403);
    assert.equal((await api('DELETE', `/api/clips/${clipId}`, { token: tokens.bob })).status, 403);
    assert.equal((await api('PUT', `/api/clips/${clipId}/favorite`, { token: tokens.bob })).status, 200);
    assert.deepEqual((await api('GET', '/api/clips/favorites', { token: tokens.alice })).body, [], 'favourites are per user');
  });

  test('the uploader and admins can', async () => {
    assert.equal((await api('PATCH', `/api/clips/${clipId}`, { token: tokens.alice, json: { emoji: '🎺' } })).status, 200);
    assert.equal((await api('PATCH', `/api/clips/${clipId}`, { token: tokens.admin, json: { name: 'Renamed' } })).status, 200);
    assert.equal((await api('DELETE', `/api/clips/${clipId}`, { token: tokens.admin })).status, 204);
  });
});

describe('Spotify linking and playlist permissions', () => {
  test('not linked → 503 for playback routes', async () => {
    const res = await api('POST', '/api/spotify/pause', { token: tokens.alice });
    assert.equal(res.status, 503);
    const status = (await api('GET', '/api/spotify/status', { token: tokens.alice })).body;
    assert.deepEqual(status, { configured: true, connected: false, canConnect: false, playlists: false });
    assert.equal((await api('GET', '/api/spotify/status', { token: tokens.admin })).body.canConnect, true);
  });

  test('/api/spotify/login?token= is admin-only', async () => {
    for (const q of ['', '?token=', `?token=${tokens.bob}`, '?token=garbage', `?token=${tokens.admin}&token=x`]) {
      assert.equal((await redirect(`/api/spotify/login${q}`)).status, 403, q);
    }
    const res = await redirect(`/api/spotify/login?token=${tokens.admin}`);
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location'));
    assert.equal(url.origin, 'https://accounts.spotify.com');

    const done = await redirect(`/api/spotify/callback?code=c&state=${url.searchParams.get('state')}`);
    assert.equal(done.headers.get('location'), `${WEB}/?spotify=connected#spotify`);
    assert.equal((await api('GET', '/api/spotify/status', { token: tokens.bob })).body.connected, true);
  });

  test('the Spotify callback surfaces a denied consent as an error', async () => {
    const res = await redirect('/api/spotify/callback?error=access_denied');
    assert.equal(res.headers.get('location'), `${WEB}/?spotify=error#spotify`);
  });

  test('name/emoji/tags/delete: creator or admin; shuffle and songs: anyone', async () => {
    const created = await api('POST', '/api/spotify/playlists', { token: tokens.alice, json: { name: 'Alice mix' } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const uri = [...fake.catalog.values()][0].uri;

    for (const body of [{ name: 'Bob mix' }, { emoji: '💀' }, { tags: 'x' }, { name: 'B', shuffle: true }]) {
      assert.equal((await api('PATCH', `/api/spotify/playlists/${id}`, { token: tokens.bob, json: body })).status, 403, JSON.stringify(body));
    }
    assert.equal((await api('PATCH', `/api/spotify/playlists/${id}`, { token: tokens.bob, json: { shuffle: true } })).body.shuffle, true);
    assert.equal((await api('POST', `/api/spotify/playlists/${id}/tracks`, { token: tokens.bob, json: { uri } })).status, 201);
    assert.equal((await api('DELETE', `/api/spotify/playlists/${id}/tracks`, { token: tokens.bob, json: { uri } })).status, 200);
    assert.equal((await api('DELETE', `/api/spotify/playlists/${id}`, { token: tokens.bob })).status, 403);

    assert.equal((await api('PATCH', `/api/spotify/playlists/${id}`, { token: tokens.admin, json: { name: 'Admin mix' } })).body.name, 'Admin mix');
    assert.equal((await api('DELETE', `/api/spotify/playlists/${id}`, { token: tokens.alice })).status, 204);
  });

  test('a token linked without playlist scopes gets a 403 asking to reconnect', async () => {
    const authFile = require('node:path').join(db.dataDir, 'spotify-auth.json');
    const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    // Simulate an old link by refreshing with a narrower scope.
    fake.scope = 'user-read-playback-state user-modify-playback-state';
    fake.revokeAccessToken();
    const spotify = require('../src/server/spotify');
    await spotify.search('a').catch(() => {}); // 401 → refresh learns the new scope
    const res = await api('GET', '/api/spotify/playlists/1/tracks', { token: tokens.alice });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /reconnected/);
    assert.equal(saved.refreshToken, 'refresh-1');
  });
});

describe('WebSocket', () => {
  async function authed(token = tokens.alice) {
    const sock = await openSocket(srv.wsUrl);
    sock.send({ type: 'auth', token });
    await sock.next('auth');
    return sock;
  }

  test('auth handshake sends the full snapshot', async () => {
    const sock = await openSocket(srv.wsUrl);
    sock.send({ type: 'auth', token: tokens.alice });
    const ok = await sock.next('auth');
    assert.deepEqual(ok, { type: 'auth', ok: true, user: { userId: 'alice', username: 'Alice', avatar: null } });
    for (const type of ['status', 'queue', 'playlists', 'youtube']) await sock.next(type);
    assert.equal(typeof sock.frames.find((f) => f.type === 'youtube').serverNow, 'number');
    sock.ws.close();
  });

  test('an invalid token gets ok:false and close 4003', async () => {
    const sock = await openSocket(srv.wsUrl);
    sock.send({ type: 'auth', token: 'nope' });
    assert.deepEqual(await sock.next('auth'), { type: 'auth', ok: false });
    assert.equal((await sock.closed).code, 4003);
  });

  test('a socket that never authenticates is closed with 4001', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 10_000 ? 50 : ms, ...args);
    try {
      const sock = await openSocket(srv.wsUrl);
      await flush();
      globalThis.setTimeout = realSetTimeout;
      assert.equal((await sock.closed).code, 4001);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('every command is ignored before auth', async (t) => {
    const volume = t.mock.method(sessionManager, 'setMusicVolume');
    const stop = t.mock.method(sessionManager, 'stopClip');
    const before = watch.get();
    const sock = await openSocket(srv.wsUrl);
    for (const msg of [
      { type: 'play', clipId: 1 }, { type: 'stop' }, { type: 'volume', value: 5 }, { type: 'spotify:pause' },
      { type: 'yt:load', videoId: 'dQw4w9WgXcQ' }, { type: 'yt:enqueue', videoId: 'dQw4w9WgXcQ' }, { type: 'yt:play', position: 1 },
      { type: 'yt:clear' }, { type: 'yt:skip' }, { type: 'yt:ended', videoId: 'x' }, { type: 'yt:meta', videoId: 'x', duration: 5 },
      { type: 'yt:dequeue', id: 1 },
    ]) sock.send(msg);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sock.frames, [], 'no replies, no broadcasts');
    assert.equal(volume.mock.callCount(), 0);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(watch.get(), before);
    assert.equal(fake.oembedCalls.length, 0);
    sock.ws.close();
  });

  test('malformed frames never crash the server (before or after auth)', async () => {
    const junk = ['null', '5', '"str"', '[]', '{}', '{"type":null}', 'not json', '{"type":"auth"}', '{"type":"__proto__"}'];
    const pre = await openSocket(srv.wsUrl);
    for (const frame of junk.filter((f) => f !== '{"type":"auth"}')) pre.send(frame);
    const post = await authed();
    for (const frame of junk.filter((f) => !f.includes('auth'))) post.send(frame);
    for (const msg of [
      { type: 'yt:seek', position: { $gt: 1 } }, { type: 'yt:play', position: '1e999' }, { type: 'yt:dequeue', id: { a: 1 } },
      { type: 'yt:meta', videoId: ['x'], duration: 'NaN' }, { type: 'yt:ended', videoId: null }, { type: 'yt:load', videoId: 12345678901 },
      { type: 'play', clipId: { id: 1 } }, { type: 'play', clipId: '../../1' }, { type: 'volume', value: '1e999' }, { type: 'volume' },
    ]) post.send(msg);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await api('GET', '/api/health')).status, 200);
    assert.equal(pre.ws.readyState, pre.ws.OPEN);
    assert.equal(post.ws.readyState, post.ws.OPEN);
    post.clear();
    post.send({ type: 'play', clipId: 999_999 });
    assert.deepEqual(await post.next('error'), { type: 'error', error: 'Clip not found', clipId: 999_999 });
    pre.ws.close();
    post.ws.close();
  });

  test('volume, yt and spotify errors over the socket', async (t) => {
    const volume = t.mock.method(sessionManager, 'setMusicVolume', () => 50);
    const sock = await authed();
    sock.send({ type: 'volume', value: 'loud' });
    sock.send({ type: 'volume', value: '30' });
    sock.send({ type: 'yt:load', videoId: 'nope' });
    assert.equal((await sock.next('error')).error, 'Invalid YouTube video');
    assert.deepEqual(volume.mock.calls.map((c) => c.arguments[0]), [30]);

    fake.oembed = () => ({ status: 401, body: {} });
    sock.send({ type: 'yt:load', videoId: 'aaaaaaaaaaa' });
    assert.match((await sock.next('error')).error, /embedded/);

    fake.deviceOnline = false;
    sock.send({ type: 'spotify:pause' });
    assert.equal((await sock.next('error')).error, 'Spotify request failed');
    fake.deviceOnline = true;
    sock.ws.close();
  });

  test('broadcasts reach authenticated sockets only', async () => {
    fake.oembed = () => ({ status: 200, body: { title: 'Shared' } });
    const a = await authed(tokens.alice);
    const b = await authed(tokens.bob);
    const anon = await openSocket(srv.wsUrl);
    await new Promise((r) => setTimeout(r, 50));
    a.clear();
    b.clear();
    a.send({ type: 'yt:load', videoId: 'dQw4w9WgXcQ' });
    const seen = await b.next('youtube');
    assert.equal(seen.youtube.videoId, 'dQw4w9WgXcQ');
    assert.equal(seen.youtube.title, 'Shared');
    assert.deepEqual(seen.youtube.by, { userId: 'alice', username: 'Alice' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(anon.frames, []);
    for (const s of [a, b, anon]) s.ws.close();
  });
});

test('no unhandled promise rejections', () => {
  assert.deepEqual(unhandled.map(String), []);
});
