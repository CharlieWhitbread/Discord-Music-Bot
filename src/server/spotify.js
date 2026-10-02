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
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const STATE_TTL_MS = 10 * 60 * 1000;

const tokenFile = path.join(dataDir, 'spotify-auth.json');

/** Emits 'nowplaying' with the latest playback state (ws broadcasts). */
const events = new EventEmitter();

/** @type {Map<string, number>} state → expiry (CSRF protection) */
const pendingStates = new Map();

let refreshToken = null;
let accessToken = null;
let accessExpiry = 0;
let deviceId = null;
let lastNowPlaying = null;
let fetchInFlight = null;

try {
  refreshToken = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken || null;
} catch { /* not connected yet */ }

function configured() {
  return Boolean(config.spotify.clientId && config.spotify.clientSecret && config.server.publicApiUrl);
}

function connected() {
  return configured() && Boolean(refreshToken);
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
  accessToken = data.access_token;
  accessExpiry = Date.now() + data.expires_in * 1000;
  fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken }), { mode: 0o600 });
  console.log('[spotify] account connected, refresh token stored');
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiry - 30_000) return accessToken;
  if (!refreshToken) throw new Error('Spotify is not connected');
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  accessToken = data.access_token;
  accessExpiry = Date.now() + data.expires_in * 1000;
  // Spotify occasionally rotates the refresh token.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    fs.writeFileSync(tokenFile, JSON.stringify({ refreshToken }), { mode: 0o600 });
  }
  return accessToken;
}

/* ─────────────────────────── Web API ─────────────────────────── */

async function api(method, endpoint, { query, body } = {}) {
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
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Spotify API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : null;
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
  try {
    await fn(await getDeviceId());
  } catch (err) {
    if (err.status !== 404) throw err;
    deviceId = null;
    await fn(await getDeviceId(true));
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

const playUri = (uri) => withDevice((id) => api('PUT', '/me/player/play', { query: { device_id: id }, body: { uris: [uri] } }));
const queueUri = (uri) => withDevice((id) => api('POST', '/me/player/queue', { query: { uri, device_id: id } }));
const pause = () => withDevice((id) => api('PUT', '/me/player/pause', { query: { device_id: id } }));
const resume = () => withDevice((id) => api('PUT', '/me/player/play', { query: { device_id: id } }));
const next = () => withDevice((id) => api('POST', '/me/player/next', { query: { device_id: id } }));
const previous = () => withDevice((id) => api('POST', '/me/player/previous', { query: { device_id: id } }));

/* ─────────────────────────── now playing ─────────────────────────── */

async function fetchNowPlaying() {
  if (!connected()) return null;
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = (async () => {
    const data = await api('GET', '/me/player');
    const item = data?.item;
    const np = !item ? { active: false } : {
      active: true,
      isPlaying: Boolean(data.is_playing),
      progressMs: data.progress_ms ?? 0,
      fetchedAt: Date.now(),
      onOurDevice: data.device?.name === config.librespot.deviceName,
      track: {
        uri: item.uri,
        name: item.name,
        artists: (item.artists ?? []).map((a) => a.name).join(', '),
        album: item.album?.name ?? '',
        image: item.album?.images?.[1]?.url ?? item.album?.images?.[0]?.url ?? null,
        durationMs: item.duration_ms ?? 0,
      },
    };
    lastNowPlaying = np;
    events.emit('nowplaying', np);
    return np;
  })().finally(() => { fetchInFlight = null; });
  return fetchInFlight;
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
  loginUrl,
  handleCallback,
  search,
  getTrack,
  playUri,
  queueUri,
  pause,
  resume,
  next,
  previous,
  fetchNowPlaying,
  getLastNowPlaying,
};
