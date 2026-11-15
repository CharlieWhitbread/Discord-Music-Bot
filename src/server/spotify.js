'use strict';

/**
 * spotify — server-held Spotify Web API client for the jukebox.
 *
 * The bot's owner connects their Premium account once via OAuth
 * (GET /api/spotify/login → callback). Only the refresh token is
 * persisted (data/spotify-auth.json); access tokens live in memory and
 * are refreshed on demand. Tokens never reach the browser — the web app
 * talks to our API, which proxies search/playback to Spotify targeting
 * the librespot Connect device by name.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('../config');
const { dataDir } = require('./db');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const PLAYLIST_SCOPES = [
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
  // DELETE /me/library is how a playlist is removed (unfollowed) since Feb 2026.
  'user-library-modify',
];
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', ...PLAYLIST_SCOPES].join(' ');
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_RETRY_AFTER_S = 5;
const MAX_PLAYLIST_ITEMS = 1000;

const tokenFile = path.join(dataDir, 'spotify-auth.json');

/** Emits 'nowplaying' with the latest playback state (ws broadcasts). */
const events = new EventEmitter();

/** @type {Map<string, number>} state → expiry (CSRF protection) */
const pendingStates = new Map();

let refreshToken = null;
/** Space-separated scopes granted to the stored token; null = not yet known. */
let grantedScope = null;
let accessToken = null;
let accessExpiry = 0;
/** Shared refresh so concurrent callers don't each burn a token request. */
let refreshInFlight = null;
let deviceId = null;
let lastNowPlaying = null;
let fetchInFlight = null;
let fetchInFlightAt = 0;
let lastLocalPauseAt = 0;
/** Cached now-playing results older than this predate a command — stale. */
let lastCommandAt = 0;

try {
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  refreshToken = saved.refreshToken || null;
  grantedScope = saved.scope ?? null;
} catch { /* not connected yet */ }

function saveTokens() {
  fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken, scope: grantedScope }), { mode: 0o600 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configured() {
  return Boolean(config.spotify.clientId && config.spotify.clientSecret && config.server.publicApiUrl);
}

function connected() {
  return configured() && Boolean(refreshToken);
}

/**
 * Playlists need scopes added after the account was first linked. Unknown
 * scope (pre-upgrade token file) resolves on the first token refresh.
 * @returns {Promise<boolean>}
 */
async function hasPlaylistAccess() {
  if (!connected()) return false;
  if (grantedScope === null) await getAccessToken().catch(() => {});
  const granted = new Set((grantedScope ?? '').split(' '));
  return PLAYLIST_SCOPES.every((s) => granted.has(s));
}

function redirectUri() {
  return `${config.server.publicApiUrl}/api/spotify/callback`;
}

/* ─────────────────────────── OAuth ─────────────────────────── */

function loginUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  for (const [s, exp] of pendingStates) {
    if (exp < Date.now()) pendingStates.delete(s);
  }
  const url = new URL(`${ACCOUNTS}/authorize`);
  url.searchParams.set('client_id', config.spotify.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(params) {
  const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spotify token request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function handleCallback(code, state) {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expiry || expiry < Date.now()) throw new Error('Invalid or expired state');

  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  refreshToken = data.refresh_token;
  grantedScope = data.scope ?? '';
  accessToken = data.access_token;
  accessExpiry = Date.now() + data.expires_in * 1000;
  saveTokens();
  console.log('[spotify] account connected, refresh token stored');
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiry - 30_000) return accessToken;
  if (!refreshToken) throw new Error('Spotify is not connected');
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function refreshAccessToken() {
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  accessToken = data.access_token;
  accessExpiry = Date.now() + data.expires_in * 1000;
  let changed = false;
  // Spotify occasionally rotates the refresh token.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    changed = true;
  }
  if (typeof data.scope === 'string' && data.scope !== grantedScope) {
    grantedScope = data.scope;
    changed = true;
  }
  if (changed) saveTokens();
  return accessToken;
}

/* ─────────────────────────── Web API ─────────────────────────── */

/**
 * Spotify Web API call. Retries once on 429 (short Retry-After), on 401
 * (token revoked early) and on 5xx for idempotent methods only — a
 * retried POST /next would skip twice.
 */
async function api(method, endpoint, { query, body } = {}, attempt = 0) {
  const token = await getAccessToken();
  const url = new URL(`${API}${endpoint}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (attempt === 0) {
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 1;
      if (wait <= MAX_RETRY_AFTER_S) {
        console.warn(`[spotify] rate limited, retrying in ${wait}s`);
        await sleep(wait * 1000);
        return api(method, endpoint, { query, body }, 1);
      }
    } else if (res.status === 401) {
      accessToken = null;
      return api(method, endpoint, { query, body }, 1);
    } else if (res.status >= 500 && (method === 'GET' || method === 'PUT')) {
      await sleep(500);
      return api(method, endpoint, { query, body }, 1);
    }
  }

  // Player endpoints answer 202/204 with an empty (or non-JSON) body, so
  // read text first — res.json() on an empty 202 throws and made
  // successful commands look like failures.
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch { /* not JSON */ }
    const err = new Error(`Spotify API ${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Resolve the Connect device id of our librespot instance (matched by
 * device name). Only exists while the bot has an active session.
 */
async function getDeviceId(force = false) {
  if (deviceId && !force) return deviceId;
  const data = await api('GET', '/me/player/devices');
  const dev = data?.devices?.find((d) => d.name === config.librespot.deviceName);
  if (!dev) {
    const err = new Error(`Speaker "${config.librespot.deviceName}" not found — is the bot in a voice channel?`);
    err.status = 409;
    throw err;
  }
  deviceId = dev.id;
  return deviceId;
}

/** Run a device-targeted call; retry once with a fresh device id on 404. */
async function withDevice(fn) {
  lastCommandAt = Date.now();
  try {
    await fn(await getDeviceId());
  } catch (err) {
    if (err.status !== 404) throw err;
    deviceId = null;
    await fn(await getDeviceId(true));
  } finally {
    lastCommandAt = Date.now();
  }
  scheduleNowPlayingRefresh();
}

/* ─────────────────────────── playback ─────────────────────────── */

function mapTrack(t) {
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    image: t.album?.images?.at(-1)?.url ?? null,
    durationMs: t.duration_ms,
  };
}

function search(q) {
  // Spotify capped /search's limit at 10 (Feb 2026); higher values 400.
  return api('GET', '/search', { query: { q, type: 'track', limit: 10 } }).then((data) =>
    (data?.tracks?.items ?? []).map(mapTrack));
}

/** Authoritative track metadata by id (used when queueing). */
function getTrack(id) {
  return api('GET', `/tracks/${id}`).then(mapTrack);
}

const playUris = (uris) => withDevice((id) => api('PUT', '/me/player/play', { query: { device_id: id }, body: { uris } }));
const playUri = (uri) => playUris([uri]);
/** Play a playlist/album as the context, so Spotify advances through it itself. */
const playContext = (contextUri, position = 0) => withDevice((id) => api('PUT', '/me/player/play', {
  query: { device_id: id },
  body: { context_uri: contextUri, offset: { position }, position_ms: 0 },
}));
/** Spotify's native queue: plays before the context continues. */
const queueUri = (uri) => withDevice((id) => api('POST', '/me/player/queue', { query: { uri, device_id: id } }));
const setShuffle = (state) => withDevice((id) => api('PUT', '/me/player/shuffle', { query: { state: Boolean(state), device_id: id } }));
const pause = () => {
  lastLocalPauseAt = Date.now();
  return withDevice((id) => api('PUT', '/me/player/pause', { query: { device_id: id } }));
};
const resume = () => withDevice((id) => api('PUT', '/me/player/play', { query: { device_id: id } }));
const next = () => withDevice((id) => api('POST', '/me/player/next', { query: { device_id: id } }));
const previous = () => withDevice((id) => api('POST', '/me/player/previous', { query: { device_id: id } }));

/* ─────────────────────────── playlists ─────────────────────────── */

/** @returns {Promise<{id: string}>} a new private playlist on the linked account */
async function createPlaylist(name, description) {
  const data = await api('POST', '/me/playlists', { body: { name, description, public: false } });
  return { id: data.id };
}

const renamePlaylist = (id, name) => api('PUT', `/playlists/${id}`, { body: { name } });

/** There is no delete in Spotify — removing it from the library unfollows it. */
const removePlaylist = (id) => api('DELETE', '/me/library', { query: { uris: `spotify:playlist:${id}` } });

/** Every playable track in a playlist (paginated, capped). */
async function getPlaylistTracks(id) {
  const tracks = [];
  for (let offset = 0; offset < MAX_PLAYLIST_ITEMS;) {
    const page = await api('GET', `/playlists/${id}/items`, { query: { limit: 50, offset } });
    const entries = page?.items ?? [];
    for (const entry of entries) {
      // Feb 2026 renamed track → item; accept both.
      const t = entry?.item ?? entry?.track;
      if (t?.uri?.startsWith('spotify:track:')) tracks.push(mapTrack(t));
    }
    offset += entries.length;
    if (!page?.next || entries.length === 0) break;
  }
  return tracks;
}

const addPlaylistTracks = (id, uris) => api('POST', `/playlists/${id}/items`, { body: { uris } });
const removePlaylistTracks = (id, uris) =>
  api('DELETE', `/playlists/${id}/items`, { body: { items: uris.map((uri) => ({ uri })) } });

/* ─────────────────────────── now playing ─────────────────────────── */

/**
 * Log playback changes the bot didn't cause. "Random pauses" are almost
 * always another client on the same account taking over, so make that
 * visible in the logs.
 */
function logExternalChanges(prev, np) {
  if (!prev?.active || !prev.isPlaying) return;
  if (!np.active) {
    console.warn('[spotify] playback stopped — no active device on the account');
    return;
  }
  if (prev.onOurDevice && !np.onOurDevice) {
    console.warn(`[spotify] playback moved to another device ("${np.deviceName}") — the bot's Spotify account is being used elsewhere`);
    return;
  }
  if (!np.isPlaying && np.track.uri === prev.track.uri && Date.now() - lastLocalPauseAt > 5000) {
    const elapsed = Date.now() - (prev.fetchedAt ?? Date.now());
    const remaining = prev.track.durationMs - (prev.progressMs ?? 0) - elapsed;
    if (remaining > 3000) {
      console.warn(`[spotify] playback paused outside the bot (device "${np.deviceName}") during "${np.track.name}"`);
    }
  }
}

/**
 * @param {{maxAgeMs?: number}} [opts] reuse a recent result to save API
 *   calls when several pollers (ws, queue watcher) run at once
 */
async function fetchNowPlaying({ maxAgeMs = 0 } = {}) {
  if (!connected()) return null;
  if (
    maxAgeMs && lastNowPlaying?.receivedAt &&
    Date.now() - lastNowPlaying.receivedAt < maxAgeMs &&
    lastNowPlaying.requestedAt > lastCommandAt
  ) {
    return lastNowPlaying;
  }
  // Share an in-flight request only if it was sent after the last command.
  if (fetchInFlight && fetchInFlightAt > lastCommandAt) return fetchInFlight;
  const requestedAt = Date.now();
  fetchInFlightAt = requestedAt;
  const request = (async () => {
    const data = await api('GET', '/me/player');
    const item = data?.item;
    const np = !item ? { active: false, requestedAt, receivedAt: Date.now() } : {
      active: true,
      isPlaying: Boolean(data.is_playing),
      progressMs: data.progress_ms ?? 0,
      fetchedAt: Date.now(),
      requestedAt,
      receivedAt: Date.now(),
      onOurDevice: data.device?.name === config.librespot.deviceName,
      deviceName: data.device?.name ?? null,
      shuffle: Boolean(data.shuffle_state),
      context: data.context?.uri ? { type: data.context.type, uri: data.context.uri } : null,
      track: {
        uri: item.uri,
        name: item.name,
        artists: (item.artists ?? []).map((a) => a.name).join(', '),
        album: item.album?.name ?? '',
        image: item.album?.images?.[1]?.url ?? item.album?.images?.[0]?.url ?? null,
        durationMs: item.duration_ms ?? 0,
      },
    };
    // An older request finishing late must not overwrite newer state, and
    // one sent before a command describes the player before it — publishing
    // it would flip every client back until the post-command refresh lands.
    if (lastNowPlaying?.requestedAt > requestedAt || requestedAt <= lastCommandAt) return np;
    logExternalChanges(lastNowPlaying, np);
    lastNowPlaying = np;
    events.emit('nowplaying', np);
    return np;
  })().finally(() => {
    if (fetchInFlight === request) fetchInFlight = null;
  });
  fetchInFlight = request;
  return request;
}

/** Refresh shortly after a control action, once Spotify's state settles. */
function scheduleNowPlayingRefresh() {
  const timer = setTimeout(() => {
    fetchNowPlaying().catch((err) => console.error(`[spotify] now-playing refresh failed: ${err.message}`));
  }, 400);
  timer.unref();
}

const getLastNowPlaying = () => lastNowPlaying;

module.exports = {
  events,
  configured,
  connected,
  hasPlaylistAccess,
  loginUrl,
  handleCallback,
  search,
  getTrack,
  playUri,
  playUris,
  playContext,
  queueUri,
  setShuffle,
  pause,
  resume,
  next,
  previous,
  createPlaylist,
  renamePlaylist,
  removePlaylist,
  getPlaylistTracks,
  addPlaylistTracks,
  removePlaylistTracks,
  fetchNowPlaying,
  getLastNowPlaying,
};
