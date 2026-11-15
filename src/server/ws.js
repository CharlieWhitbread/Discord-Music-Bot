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
 *                    {type:'spotify:pause'} / {type:'spotify:resume'}
 *                    {type:'volume', value}   music-only, 0–100
 *                    {type:'yt:load'|'yt:enqueue', videoId}  play now / add to queue
 *                    {type:'yt:play'|'yt:pause'|'yt:seek', position}
 *                    {type:'yt:dequeue', id} / {type:'yt:skip'} / {type:'yt:clear'}
 *                    {type:'yt:ended', videoId} / {type:'yt:meta', videoId, duration}
 *   server → client: {type:'auth', ok, user?}
 *                    {type:'status', status}   pushed on every state change
 *                    {type:'spotify', spotify} now-playing updates
 *                    {type:'queue', queue}     bot queue updates
 *                    {type:'playlists', playlists}  web-app playlist tiles
 *                    {type:'youtube', youtube, serverNow}  watch-together state
 *                    {type:'error', error, clipId?}
 */

const { WebSocketServer } = require('ws');
const sessionManager = require('../audio/sessionManager');
const spotify = require('./spotify');
const queue = require('./queue');
const playlists = require('./playlists');
const watch = require('./watch');
const { resolveToken } = require('./auth');
const { triggerClip } = require('./routes/play');
const { pausePlayback, resumePlayback } = require('./routes/spotify');

const AUTH_TIMEOUT_MS = 10_000;
const SPOTIFY_POLL_MS = 5_000;

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

  const broadcastSpotify = (spotifyState) => {
    const frame = JSON.stringify({ type: 'spotify', spotify: spotifyState });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client.isAuthed) client.send(frame);
    }
  };
  spotify.events.on('nowplaying', broadcastSpotify);

  const broadcastQueue = (items) => {
    const frame = JSON.stringify({ type: 'queue', queue: items });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client.isAuthed) client.send(frame);
    }
  };
  queue.events.on('update', broadcastQueue);

  const broadcastPlaylists = (items) => {
    const frame = JSON.stringify({ type: 'playlists', playlists: items });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client.isAuthed) client.send(frame);
    }
  };
  playlists.events.on('update', broadcastPlaylists);

  // serverNow lets clients estimate clock offset for the playback anchor.
  const youtubeFrame = (state) =>
    JSON.stringify({ type: 'youtube', youtube: state, serverNow: Date.now() });
  const broadcastYoutube = (state) => {
    const frame = youtubeFrame(state);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN && client.isAuthed) client.send(frame);
    }
  };
  watch.events.on('update', broadcastYoutube);

  // Poll Spotify only while someone is actually watching.
  const hasAuthedClient = () => [...wss.clients].some((c) => c.isAuthed);
  const spotifyPoll = setInterval(() => {
    if (!spotify.connected() || !hasAuthedClient()) return;
    spotify.fetchNowPlaying({ maxAgeMs: 2000 }).catch((err) => {
      console.error(`[spotify] poll failed: ${err.message}`);
    });
  }, SPOTIFY_POLL_MS);
  spotifyPoll.unref();

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
      // `null`, numbers, strings and arrays are valid JSON too; a throw
      // here would escape the ws receiver and wedge the socket.
      if (!msg || typeof msg !== 'object') return;

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
        const np = spotify.getLastNowPlaying();
        if (np) socket.send(JSON.stringify({ type: 'spotify', spotify: np }));
        socket.send(JSON.stringify({ type: 'queue', queue: queue.list() }));
        socket.send(JSON.stringify({ type: 'playlists', playlists: playlists.list() }));
        socket.send(youtubeFrame(watch.get()));
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
        return;
      }

      if (msg.type === 'spotify:pause' || msg.type === 'spotify:resume') {
        const run = msg.type === 'spotify:pause' ? pausePlayback : resumePlayback;
        run().catch((err) => {
          console.error(`[spotify] ${msg.type} failed: ${err.message}`);
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'error', error: 'Spotify request failed' }));
          }
        });
        return;
      }

      if (msg.type === 'volume' && Number.isFinite(Number(msg.value))) {
        sessionManager.setMusicVolume(Number(msg.value));
        return;
      }

      if (msg.type === 'yt:load' || msg.type === 'yt:enqueue') {
        const run = msg.type === 'yt:load' ? watch.load : watch.enqueue;
        run(msg.videoId, socket.user).catch((err) => {
          if (!err.expose) console.error(`[watch] ${msg.type} failed: ${err.message}`);
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'error', error: err.expose ? err.message : 'Could not load that video' }));
          }
        });
        return;
      }

      if (msg.type === 'yt:play' || msg.type === 'yt:pause' || msg.type === 'yt:seek') {
        watch.control(msg.type.slice(3), msg.position, socket.user);
        return;
      }

      if (msg.type === 'yt:dequeue') {
        watch.dequeue(msg.id, socket.user);
        return;
      }

      if (msg.type === 'yt:skip') {
        watch.skip(socket.user);
        return;
      }

      if (msg.type === 'yt:ended') {
        watch.ended(msg.videoId);
        return;
      }

      if (msg.type === 'yt:meta') {
        watch.reportDuration(msg.videoId, msg.duration);
        return;
      }

      if (msg.type === 'yt:clear') {
        watch.clear(socket.user);
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
      clearInterval(spotifyPoll);
      sessionManager.events.off('status', broadcast);
      spotify.events.off('nowplaying', broadcastSpotify);
      queue.events.off('update', broadcastQueue);
      playlists.events.off('update', broadcastPlaylists);
      watch.events.off('update', broadcastYoutube);
      watch.stop();
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

module.exports = { attach };
