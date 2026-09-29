'use strict';

/**
 * server — Express API + WebSocket for the web soundboard, running inside
 * the bot process (imports sessionManager directly, no IPC).
 */

const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const auth = require('./auth');
const clipsRouter = require('./routes/clips');
const { router: playRouter } = require('./routes/play');
const spotifyRouter = require('./routes/spotify');
const ws = require('./ws');

/** @type {{httpServer: import('node:http').Server, wsHandle: {close: () => void}}|null} */
let running = null;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Cloudflare Tunnel / Tailscale Funnel

  app.use(helmet());

  // Pin CORS to the deployed web app; always allow localhost for dev.
  const allowed = new Set(
    [config.server.webOrigin, 'http://localhost:5173', 'http://127.0.0.1:5173'].filter(Boolean),
  );
  app.use(cors({
    origin(origin, cb) {
      // No Origin header = same-origin/curl; allow.
      if (!origin || allowed.has(origin)) cb(null, true);
      else cb(new Error('Origin not allowed'));
    },
  }));

  app.use(express.json({ limit: '64kb' }));

  /* ── auth ── */
  app.get('/api/auth/login', auth.login);
  app.get('/api/auth/callback', auth.callback);
  app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json(req.user));

  /* ── rate limits (uploads are expensive; plays are spam-able) ── */
  const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true });
  const playLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true });
  const spotifyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true });

  /* ── API ── */
  app.use('/api/clips', (req, res, next) => (req.method === 'POST' ? uploadLimiter(req, res, next) : next()), clipsRouter);
  app.use('/api/spotify', spotifyLimiter, spotifyRouter);
  app.use('/api', (req, res, next) => (req.path.startsWith('/play') ? playLimiter(req, res, next) : next()), playRouter);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // JSON errors, never stack traces.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.message === 'Origin not allowed' ? 403
      : err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    if (status === 500) console.error('[server] error:', err.message);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  });

  return app;
}

function start() {
  if (running) return;
  if (!config.server.enabled) {
    console.log('[server] disabled via SOUNDBOARD_ENABLED=false');
    return;
  }
  if (!config.server.authDisabled && !auth.authConfigured()) {
    console.warn(
      '[server] OAuth not fully configured (need DISCORD_CLIENT_SECRET, PUBLIC_API_URL, WEB_ORIGIN, GUILD_ID). ' +
      'Set AUTH_DISABLED=true for LAN development, or configure OAuth. Server not started.',
    );
    return;
  }

  const app = buildApp();
  const httpServer = http.createServer(app);
  const wsHandle = ws.attach(httpServer);

  httpServer.listen(config.server.port, () => {
    console.log(`[server] soundboard API listening on :${config.server.port}` +
      (config.server.authDisabled ? ' (AUTH DISABLED — LAN dev only!)' : ''));
  });
  httpServer.on('error', (err) => {
    console.error(`[server] http error: ${err.message}`);
  });

  running = { httpServer, wsHandle };
}

function stop() {
  if (!running) return;
  running.wsHandle.close();
  running.httpServer.close();
  running = null;
}

module.exports = { start, stop };
