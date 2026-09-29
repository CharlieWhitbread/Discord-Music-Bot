'use strict';

/**
 * ws — the primary press-to-sound channel. A persistent socket means a
 * button press costs one hot round trip (~30–80 ms) instead of a fresh
 * TLS handshake through the tunnel.
 *
 * Protocol (JSON text frames):
 *   client → server: {type:'auth', token}   must be the first message
 *                    {type:'play', clipId}
 *                    {type:'stop'}
 *   server → client: {type:'auth', ok, user?}
 *                    {type:'status', status}   pushed on every state change
 *                    {type:'error', error, clipId?}
 */

const { WebSocketServer } = require('ws');
const sessionManager = require('../audio/sessionManager');
const { resolveToken } = require('./auth');
const { triggerClip } = require('./routes/play');

const AUTH_TIMEOUT_MS = 10_000;

/**
 * @param {import('node:http').Server} httpServer
 * @returns {{close: () => void}}
 */
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const broadcast = (status) => {
    const frame = JSON.stringify({ type: 'status', status });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client.isAuthed) client.send(frame);
    }
  };
  sessionManager.events.on('status', broadcast);

  wss.on('connection', (socket) => {
    socket.isAuthed = false;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    // Drop sockets that never authenticate.
    const authTimer = setTimeout(() => {
      if (!socket.isAuthed) socket.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    authTimer.unref();

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'auth') {
        const user = resolveToken(`Bearer ${msg.token}`);
        if (!user) {
          socket.send(JSON.stringify({ type: 'auth', ok: false }));
          socket.close(4003, 'invalid token');
          return;
        }
        socket.isAuthed = true;
        socket.user = user;
        socket.send(JSON.stringify({ type: 'auth', ok: true, user }));
        socket.send(JSON.stringify({ type: 'status', status: sessionManager.getStatus() }));
        return;
      }

      if (!socket.isAuthed) return;

      if (msg.type === 'play') {
        const result = triggerClip(msg.clipId);
        if (!result.ok) {
          socket.send(JSON.stringify({ type: 'error', error: result.error, clipId: msg.clipId }));
        }
        return;
      }

      if (msg.type === 'stop') {
        sessionManager.stopClip();
      }
    });

    socket.on('error', (err) => {
      console.error(`[ws] socket error: ${err.message}`);
    });
  });

  // Heartbeat: reap dead tunnel connections so broadcasts stay cheap.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      sessionManager.events.off('status', broadcast);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

module.exports = { attach };
