'use strict';

/**
 * auth — Discord OAuth2 with bearer tokens.
 *
 * Flow (SWA ↔ Pi is cross-site, so no cookies — see PLAN.md):
 *   1. Browser hits  GET /api/auth/login  → 302 to Discord authorize.
 *   2. Discord calls GET /api/auth/callback?code&state  (on the Pi's
 *      public API domain).
 *   3. We exchange the code, verify the user is a member of the bot's
 *      guild (scope: identify guilds), mint an opaque bearer token and
 *      302 back to the web app with it in the URL fragment (fragments
 *      are never sent to any server).
 *   4. The SPA stores the token and sends it via Authorization header
 *      and on WebSocket connect.
 *
 * Only a SHA-256 hash of the token is stored server-side.
 */

const crypto = require('node:crypto');
const config = require('../config');
const db = require('./db');

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, number>} state → expiry (CSRF protection) */
const pendingStates = new Map();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function redirectUri() {
  return `${config.server.publicApiUrl}/api/auth/callback`;
}

function authConfigured() {
  return Boolean(
    config.server.clientSecret && config.server.publicApiUrl && config.guildId && config.server.webOrigin,
  );
}

/* ─────────────────────────── routes ─────────────────────────── */

/** GET /api/auth/login */
function login(req, res) {
  if (!authConfigured()) {
    res.status(500).json({ error: 'OAuth is not configured on the server.' });
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  for (const [s, exp] of pendingStates) {
    if (exp < Date.now()) pendingStates.delete(s);
  }

  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  res.redirect(url.toString());
}

/** GET /api/auth/callback */
async function callback(req, res) {
  const { code, state } = req.query;
  const fail = (msg) => res.redirect(`${config.server.webOrigin}/#error=${encodeURIComponent(msg)}`);

  if (!code || !state || !pendingStates.has(state) || pendingStates.get(state) < Date.now()) {
    fail('Invalid or expired login attempt — try again.');
    return;
  }
  pendingStates.delete(state);

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.server.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri(),
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const { access_token: accessToken } = await tokenRes.json();

    const authHeader = { Authorization: `Bearer ${accessToken}` };
    const [userRes, guildsRes] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers: authHeader }),
      fetch(`${DISCORD_API}/users/@me/guilds`, { headers: authHeader }),
    ]);
    if (!userRes.ok || !guildsRes.ok) throw new Error('failed to fetch user profile');
    const user = await userRes.json();
    const guilds = await guildsRes.json();

    // The friends-only gate: must share the bot's guild.
    if (!guilds.some((g) => g.id === config.guildId)) {
      fail('You are not a member of the required Discord server.');
      return;
    }

    const bearer = crypto.randomBytes(32).toString('hex');
    db.purgeExpiredTokens();
    db.insertToken({
      tokenHash: sha256(bearer),
      userId: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : null,
      createdAt: Date.now(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    res.redirect(`${config.server.webOrigin}/#token=${bearer}`);
  } catch (err) {
    console.error('[auth] callback error:', err.message);
    fail('Login failed — try again.');
  }
}

/* ─────────────────────────── middleware ─────────────────────────── */

const DEV_USER = { userId: 'dev', username: 'dev', avatar: null };

/**
 * Resolve the bearer token to a user record.
 * @param {string|undefined} headerValue "Bearer <token>"
 * @returns {{userId: string, username: string, avatar: string|null}|null}
 */
function resolveToken(headerValue) {
  if (config.server.authDisabled) return DEV_USER;
  const token = headerValue?.startsWith('Bearer ') ? headerValue.slice(7) : null;
  if (!token) return null;
  const row = db.getToken(sha256(token));
  if (!row) return null;
  return { userId: row.user_id, username: row.username, avatar: row.avatar };
}

/** Express middleware: attaches req.user or replies 401. */
function requireAuth(req, res, next) {
  const user = resolveToken(req.headers.authorization);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  req.user = user;
  next();
}

function isAdmin(user) {
  return config.server.adminIds.includes(user.userId);
}

module.exports = { login, callback, requireAuth, resolveToken, isAdmin, authConfigured };
