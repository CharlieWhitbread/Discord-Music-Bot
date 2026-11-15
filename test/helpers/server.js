'use strict';

const net = require('node:net');
const path = require('node:path');
const { SRC } = require('./env');

/** @returns {Promise<number>} a currently free TCP port */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the real server (Express + WS) via server.start() and wait until
 * /api/health answers. SOUNDBOARD_PORT must already be in the env.
 */
async function startServer() {
  const server = require(path.join(SRC, 'server', 'server.js'));
  server.start();
  const base = `http://127.0.0.1:${process.env.SOUNDBOARD_PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { base, wsUrl: `${base.replace('http', 'ws')}/ws`, stop: () => server.stop() };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('server did not start');
}

/** fetch + JSON helper. @returns {Promise<{status: number, body: any, headers: Headers}>} */
async function call(base, method, urlPath, { token, json, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof json === 'string' ? json : JSON.stringify(json);
  }
  if (form) init.body = form;
  const res = await fetch(`${base}${urlPath}`, init);
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}

/**
 * Minimal WS client wrapper collecting frames.
 * @returns {Promise<{ws: import('ws'), frames: object[], next: (type: string) => Promise<object>, closed: Promise<{code: number, reason: string}>}>}
 */
function openSocket(url) {
  const WebSocket = require('ws');
  const ws = new WebSocket(url);
  const frames = [];
  const unclaimed = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    frames.push(msg);
    const waiter = waiters.find((w) => w.type === msg.type);
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    } else {
      unclaimed.push(msg);
    }
  });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  /** Next frame of `type`: an already-received unclaimed one, or the next to arrive. */
  const next = (type, timeoutMs = 2000) => new Promise((resolve, reject) => {
    const ready = unclaimed.findIndex((m) => m.type === type);
    if (ready !== -1) {
      resolve(unclaimed.splice(ready, 1)[0]);
      return;
    }
    const waiter = { type, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      if (waiters.includes(waiter)) reject(new Error(`no "${type}" frame within ${timeoutMs} ms`));
    }, timeoutMs).unref();
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({
      ws,
      frames,
      next,
      closed,
      /** Forget everything received so far. */
      clear: () => { frames.length = 0; unclaimed.length = 0; },
      send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    }));
    ws.once('error', reject);
  });
}

module.exports = { freePort, startServer, call, openSocket };
