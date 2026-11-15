'use strict';

/**
 * A stateful fake of the slice of Spotify (accounts + Web API) the bot uses,
 * installed by replacing global.fetch. It models:
 *
 *  - the play context: an explicit `uris` list or a playlist `context_uri`,
 *    plus the index into it
 *  - Spotify's native queue (POST /me/player/queue)
 *  - track end: the native queue plays first, then the context continues;
 *    after the last track playback stops ("paused", same item, progress 0)
 *  - pause / resume / next / previous / shuffle (shuffle is a flag only;
 *    advancing stays in order so tests are deterministic)
 *  - playlists: create, items (paginated), add, remove (all occurrences, like
 *    Spotify), rename, unfollow via DELETE /me/library
 *  - GET /me/player answering 204 with no body when idle
 *
 * Player commands answer 202/204 with an EMPTY body like real Spotify —
 * a past bug came from calling res.json() on those.
 *
 * Time comes from Date.now(), so node:test mock timers drive playback.
 * Requests to localhost pass through to the real fetch; anything else
 * throws, so no test can reach the real network by accident.
 */

const realFetch = globalThis.fetch;
// Process-wide so ids stay unique across fakes sharing one SQLite file.
let playlistSeq = 1;

const FULL_SCOPE = [
  'user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private',
  'playlist-modify-private', 'playlist-modify-public', 'user-library-modify',
].join(' ');

/** 22-char base62 id, valid for the routes' TRACK_URI regex. */
function trackId(n) {
  return `T${String(n).padStart(21, '0')}`;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** `new Response('', {status: 204})` throws — an empty body must be null. */
function empty(status = 204) {
  return new Response(null, { status });
}

function apiError(status, message) {
  return json(status, { error: { status, message } });
}

class FakeSpotify {
  constructor({ deviceName = 'DiscordBot', scope = FULL_SCOPE } = {}) {
    this.deviceName = deviceName;
    this.deviceId = 'device-1';
    this.deviceOnline = true;
    this.scope = scope;
    this.rotateRefreshToken = false;

    /** @type {Map<string, object>} id → Spotify track object */
    this.catalog = new Map();
    /** @type {Map<string, {name: string, uris: string[], followed: boolean}>} */
    this.playlists = new Map();

    /** @type {null|{contextUri: string|null, uris: string[]|null, index: number,
     *  current: string, isPlaying: boolean, progressMs: number, anchorAt: number,
     *  deviceName: string}} */
    this.player = null;
    this.nativeQueue = [];
    this.shuffle = false;

    this.tokenCounter = 0;
    /** Issued access tokens; real Spotify keeps older ones valid until expiry. */
    this.validAccessTokens = new Set();
    this.tokenRequests = [];
    this.calls = [];
    this.failures = [];
    /** YouTube oEmbed stub: videoId → {status, body} */
    this.oembed = (videoId) => ({ status: 200, body: { title: `Video ${videoId}` } });
    this.oembedCalls = [];

    this.fetch = this.fetch.bind(this);
  }

  /* ─────────────────────────── setup helpers ─────────────────────────── */

  install() {
    globalThis.fetch = this.fetch;
    return this;
  }

  uninstall() {
    globalThis.fetch = realFetch;
  }

  /** Add tracks to the catalog. @returns {string[]} their URIs */
  addTracks(count, { durationMs = 30_000, startAt = 1 } = {}) {
    const uris = [];
    for (let n = startAt; n < startAt + count; n++) {
      const id = trackId(n);
      this.catalog.set(id, {
        id,
        uri: `spotify:track:${id}`,
        name: `Track ${n}`,
        artists: [{ name: `Artist ${n}` }],
        album: { name: `Album ${n}`, images: [{ url: `https://img/${n}/640` }, { url: `https://img/${n}/300` }, { url: `https://img/${n}/64` }] },
        duration_ms: durationMs,
      });
      uris.push(`spotify:track:${id}`);
    }
    return uris;
  }

  /** Create a playlist directly (as if made in the Spotify app). */
  seedPlaylist(name, uris) {
    const id = `pl${playlistSeq++}`;
    this.playlists.set(id, { name, uris: [...uris], followed: true });
    return id;
  }

  /** Make the next `times` requests matching method/path fail. */
  fail(method, path, status, { times = 1, headers = {}, body } = {}) {
    this.failures.push({ method, path, status, times, headers, body });
  }

  /** Simulate revoked access tokens (next API call gets 401). */
  revokeAccessToken() {
    this.validAccessTokens.clear();
  }

  callsTo(method, path) {
    return this.calls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));
  }

  /* ─────────────────────────── player model ─────────────────────────── */

  trackUri(uri) {
    return this.catalog.get(uri.split(':')[2]);
  }

  contextList() {
    const p = this.player;
    if (!p) return [];
    if (p.contextUri) return this.playlists.get(p.contextUri.split(':')[2])?.uris ?? [];
    return p.uris ?? [];
  }

  /** Bring the player up to "now": apply any track ends that happened. */
  sync() {
    const p = this.player;
    if (!p || !p.isPlaying) return;
    let progress = p.progressMs + (Date.now() - p.anchorAt);
    for (;;) {
      const duration = this.trackUri(p.current)?.duration_ms ?? Infinity;
      if (progress < duration) break;
      const overflow = progress - duration;
      if (!this.advanceTrack()) {
        progress = 0;
        break;
      }
      progress = overflow;
    }
    p.progressMs = progress;
    p.anchorAt = Date.now();
  }

  /** Native queue first, then the context. @returns {boolean} false when stopped */
  advanceTrack() {
    const p = this.player;
    if (this.nativeQueue.length) {
      p.current = this.nativeQueue.shift();
      return true;
    }
    const list = this.contextList();
    if (p.index + 1 < list.length) {
      p.index++;
      p.current = list[p.index];
      return true;
    }
    p.isPlaying = false;
    p.progressMs = 0;
    return false;
  }

  start({ uris, contextUri, position = 0 }) {
    this.player = {
      contextUri: contextUri ?? null,
      uris: uris ?? null,
      index: position,
      current: null,
      isPlaying: true,
      progressMs: 0,
      anchorAt: Date.now(),
      deviceName: this.deviceName,
    };
    this.player.current = this.contextList()[position] ?? null;
  }

  /** Jump forward in the current track (e.g. to 2 s before its end). */
  seekTo(progressMs) {
    this.sync();
    this.player.progressMs = progressMs;
    this.player.anchorAt = Date.now();
  }

  /** Simulate another client on the account taking playback elsewhere. */
  moveToOtherDevice(name = 'Phone') {
    this.sync();
    this.player.deviceName = name;
  }

  state() {
    this.sync();
    return this.player;
  }

  /* ─────────────────────────── fetch ─────────────────────────── */

  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();

    if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed') {
      const videoUrl = new URL(url.searchParams.get('url'));
      const videoId = videoUrl.searchParams.get('v');
      this.oembedCalls.push(videoId);
      const r = await this.oembed(videoId, init);
      return r instanceof Response ? r : json(r.status, r.body ?? {});
    }

    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/api/token') {
      return this.handleToken(init);
    }

    if (url.hostname !== 'api.spotify.com') {
      throw new TypeError(`FakeSpotify: blocked network request to ${url}`);
    }

    const path = url.pathname.replace(/^\/v1/, '');
    let body = null;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call = { method, path, query: Object.fromEntries(url.searchParams), body, at: Date.now() };
    this.calls.push(call);

    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
    if (!this.validAccessTokens.has(auth.replace(/^Bearer /, ''))) {
      return apiError(401, 'The access token expired');
    }

    const failure = this.failures.find((f) => f.method === method &&
      (f.path instanceof RegExp ? f.path.test(path) : f.path === path));
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return failure.body !== undefined
        ? json(failure.status, failure.body, failure.headers)
        : new Response(failure.status === 204 ? null : JSON.stringify({ error: { status: failure.status, message: `injected ${failure.status}` } }), {
          status: failure.status, headers: failure.headers,
        });
    }

    return this.route(method, path, url.searchParams, body);
  }

  handleToken(init) {
    const params = new URLSearchParams(String(init.body));
    this.tokenRequests.push(Object.fromEntries(params));
    const grant = params.get('grant_type');
    if (grant !== 'refresh_token' && grant !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    this.tokenCounter++;
    const accessToken = `access-${this.tokenCounter}`;
    this.validAccessTokens.add(accessToken);
    const data = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: this.scope };
    if (grant === 'authorization_code') data.refresh_token = `refresh-${this.tokenCounter}`;
    else if (this.rotateRefreshToken) data.refresh_token = `rotated-${this.tokenCounter}`;
    return json(200, data);
  }

  checkDevice(query) {
    const id = query.get('device_id');
    if (id && (!this.deviceOnline || id !== this.deviceId)) return apiError(404, 'Device not found');
    return null;
  }

  route(method, path, query, body) {
    let m;
    const key = `${method} ${path}`;

    if (key === 'GET /me/player/devices') {
      return json(200, { devices: this.deviceOnline ? [{ id: this.deviceId, name: this.deviceName, is_active: true }] : [] });
    }

    if (key === 'GET /me/player') {
      this.sync();
      const p = this.player;
      if (!p || !p.current) return empty(204);
      return json(200, {
        device: { id: p.deviceName === this.deviceName ? this.deviceId : 'other', name: p.deviceName },
        is_playing: p.isPlaying,
        progress_ms: Math.round(p.progressMs),
        shuffle_state: this.shuffle,
        context: p.contextUri ? { type: 'playlist', uri: p.contextUri } : null,
        item: this.trackUri(p.current),
      });
    }

    if (path.startsWith('/me/player/')) {
      const bad = this.checkDevice(query);
      if (bad) return bad;
      this.sync();
    }

    if (key === 'PUT /me/player/play') {
      if (body?.uris) this.start({ uris: body.uris, position: body.offset?.position ?? 0 });
      else if (body?.context_uri) {
        const id = body.context_uri.split(':')[2];
        if (!this.playlists.has(id)) return apiError(404, 'Context not found');
        this.start({ contextUri: body.context_uri, position: body.offset?.position ?? 0 });
      } else if (this.player?.current) {
        this.player.isPlaying = true;
        this.player.anchorAt = Date.now();
        this.player.deviceName = this.deviceName;
      } else {
        return apiError(404, 'No active device found');
      }
      return empty(202);
    }
    if (key === 'PUT /me/player/pause') {
      if (!this.player) return apiError(404, 'No active device found');
      this.player.isPlaying = false;
      return empty(204);
    }
    if (key === 'POST /me/player/next') {
      if (!this.player?.current) return apiError(404, 'No active device found');
      this.player.isPlaying = this.advanceTrack();
      this.player.progressMs = 0;
      this.player.anchorAt = Date.now();
      return empty(204);
    }
    if (key === 'POST /me/player/previous') {
      if (!this.player?.current) return apiError(404, 'No active device found');
      if (this.player.progressMs < 3000 && this.player.index > 0) {
        this.player.index--;
        this.player.current = this.contextList()[this.player.index];
      }
      this.player.progressMs = 0;
      this.player.anchorAt = Date.now();
      return empty(204);
    }
    if (key === 'POST /me/player/queue') {
      if (!this.player?.current) return apiError(404, 'No active device found');
      const uri = query.get('uri');
      if (!this.trackUri(uri ?? '')) return apiError(400, 'Invalid track uri');
      this.nativeQueue.push(uri);
      return empty(202);
    }
    if (key === 'PUT /me/player/shuffle') {
      if (!this.player) return apiError(404, 'No active device found');
      this.shuffle = query.get('state') === 'true';
      return empty(204);
    }

    if (method === 'GET' && (m = path.match(/^\/tracks\/([^/]+)$/))) {
      const t = this.catalog.get(m[1]);
      return t ? json(200, t) : apiError(404, 'Non existing id');
    }
    if (key === 'GET /search') {
      const q = (query.get('q') ?? '').toLowerCase();
      const limit = Number(query.get('limit'));
      if (limit > 10) return apiError(400, 'Invalid limit');
      const items = [...this.catalog.values()].filter((t) => t.name.toLowerCase().includes(q)).slice(0, limit || 10);
      return json(200, { tracks: { items } });
    }

    /* playlists */
    if (key === 'POST /me/playlists') {
      const id = this.seedPlaylist(body.name, []);
      return json(201, { id, name: body.name, public: body.public });
    }
    if (method === 'PUT' && (m = path.match(/^\/playlists\/([^/]+)$/))) {
      const pl = this.playlists.get(m[1]);
      if (!pl) return apiError(404, 'Not found');
      if (body?.name) pl.name = body.name;
      return empty(200);
    }
    if ((m = path.match(/^\/playlists\/([^/]+)\/items$/))) {
      const pl = this.playlists.get(m[1]);
      if (!pl) return apiError(404, 'Not found');
      if (method === 'GET') {
        const offset = Number(query.get('offset') ?? 0);
        const limit = Number(query.get('limit') ?? 50);
        const slice = pl.uris.slice(offset, offset + limit);
        return json(200, {
          items: slice.map((uri) => ({ item: this.trackUri(uri) })),
          next: offset + limit < pl.uris.length ? `next?offset=${offset + limit}` : null,
          total: pl.uris.length,
        });
      }
      if (method === 'POST') {
        pl.uris.push(...body.uris);
        return json(201, { snapshot_id: `snap-${pl.uris.length}` });
      }
      if (method === 'DELETE') {
        const remove = new Set(body.items.map((i) => i.uri));
        pl.uris = pl.uris.filter((u) => !remove.has(u));
        return json(200, { snapshot_id: `snap-${pl.uris.length}` });
      }
    }
    if (key === 'DELETE /me/library') {
      for (const uri of (query.get('uris') ?? '').split(',')) {
        const pl = this.playlists.get(uri.split(':')[2]);
        if (pl) pl.followed = false;
      }
      return empty(200);
    }

    return apiError(404, `FakeSpotify: no route for ${key}`);
  }
}

module.exports = { FakeSpotify, FULL_SCOPE, trackId, json, empty };
