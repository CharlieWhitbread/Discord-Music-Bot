'use strict';

/**
 * sessionManager
 * ──────────────
 * Owns the full audio pipeline for each guild:
 *
 *   librespot (child process, --backend pipe)
 *        │  raw PCM  s16le / 44100 Hz / 2ch  (stdout)
 *        ▼
 *   Resampler (in-process) → s16le / 48000 Hz / 2ch  ← Discord's required rate
 *        ▼
 *   Mixer → AudioResource (StreamType.Raw) → AudioPlayer → VoiceConnection
 *
 * Resampling used to be an ffmpeg child process. librespot has no clock:
 * it writes as fast as the buffers downstream accept, and ffmpeg plus two
 * OS pipes held seconds of audio, so librespot ran 5–7 s ahead of Discord.
 * Pauses kept playing and Spotify's reported position jumped. Now the only
 * buffers are one OS pipe and the mixer's capped input.
 *
 * Every external resource (the librespot process and the voice connection)
 * is tracked in a Session object so that teardown is always complete and
 * idempotent, no matter which component fails first.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');
const config = require('../config');
const { Mixer } = require('./mixer');
const { Resampler } = require('./resampler');

/** @type {Map<string, Session>} guildId → active session */
const sessions = new Map();

/** Music volume (0-100). Module-level so it survives session teardown. */
let musicVolume = 100;

/** Emits 'status' whenever session/clip state changes (WS broadcasts). */
const events = new EventEmitter();

/**
 * @typedef {object} Session
 * @property {import('@discordjs/voice').VoiceConnection} connection
 * @property {import('@discordjs/voice').AudioPlayer} player
 * @property {import('node:child_process').ChildProcess|null} librespot
 * @property {import('./resampler').Resampler|null} resampler
 * @property {import('./mixer').Mixer|null} mixer
 * @property {boolean} destroyed  Guard flag making destroySession idempotent.
 */

/* ────────────────────────── child processes ────────────────────────── */

/**
 * Spawn librespot configured as a headless Spotify Connect receiver that
 * writes raw PCM to stdout.
 */
function spawnLibrespot() {
  // The cache dir holds credentials.json from the one-time OAuth login
  // (see README/PLAN): with it librespot signs into the account directly,
  // no casting needed. Without it, zeroconf discovery still works.
  fs.mkdirSync(config.librespot.cacheDir, { recursive: true });

  const args = [
    '--name', config.librespot.deviceName,
    '--backend', 'pipe',
    '--format', 'S16', // signed 16-bit little-endian
    '--initial-volume', String(config.librespot.initialVolume),
    '--bitrate', '320',
    '--cache', config.librespot.cacheDir,
    '--disable-audio-cache',
  ];

  console.log(`[librespot] spawning: ${config.librespot.path} ${args.join(' ')}`);
  const child = spawn(config.librespot.path, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // librespot logs to stderr; surface it for debugging without crashing.
  child.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.log(`[librespot] ${line}`);
  });

  return child;
}

/* ─────────────────────────── public API ─────────────────────────── */

/**
 * Create (or reuse) a session for the given voice channel.
 *
 * @param {import('discord.js').VoiceBasedChannel} voiceChannel
 * @returns {Promise<{created: boolean}>} created=false when a session already exists.
 */
async function createSession(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  if (sessions.has(guildId)) {
    return { created: false };
  }

  /** @type {Session} */
  const session = {
    connection: null,
    player: null,
    librespot: null,
    resampler: null,
    mixer: null,
    destroyed: false,
  };
  sessions.set(guildId, session);

  try {
    /* 1 ─ Join the voice channel */
    session.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    wireConnectionEvents(session, guildId);

    // Verbose state logging to diagnose handshake failures.
    session.connection.on('stateChange', (oldState, newState) => {
      console.log(`[connection:${guildId}] ${oldState.status} -> ${newState.status}`);
    });
    session.connection.on('debug', (msg) => {
      console.log(`[connection:${guildId}] debug: ${msg}`);
    });

    // Fail fast if the gateway handshake doesn't complete.
    await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);

    /* 2 ─ Spawn librespot */
    session.librespot = spawnLibrespot();
    wireProcessEvents(session, guildId);

    /* 3 ─ Build player + resource from the mixer.
     *
     * The resource must NOT read librespot's output directly: when Spotify
     * is paused, librespot stops writing PCM, the player would go Idle and
     * @discordjs/voice would destroy the stream, killing the whole session.
     * The mixer emits a frame every 20 ms no matter what (Spotify /
     * soundboard clip / silence) and its capped input buffer provides the
     * backpressure that paces librespot. */
    session.mixer = new Mixer(guildId);
    session.mixer.setMusicVolume(musicVolume / 100);
    session.mixer.on('error', (err) => {
      console.error(`[mixer:${guildId}] stream error: ${err.message}`);
    });
    session.mixer.on('clipstart', (clip) => {
      console.log(`[mixer:${guildId}] clip started: ${clip.name}`);
      emitStatus();
    });
    session.mixer.on('clipend', (clip) => {
      console.log(`[mixer:${guildId}] clip ended: ${clip.name}`);
      emitStatus();
    });
    session.mixer.on('quietunmute', (reason) => {
      if (reason === 'timeout') {
        console.warn(`[mixer:${guildId}] music still playing after a pause — unmuting (pause failed or resumed elsewhere)`);
      }
    });

    /* librespot → resampler → mixer. Pausing librespot's stdout when the
     * mixer's input is full is the backpressure; it never stops for long
     * because the mixer drains at realtime (invariant 1). */
    session.resampler = new Resampler();
    const input = session.mixer.spotifyInput;
    const stdout = session.librespot.stdout;
    stdout.on('data', (chunk) => {
      if (session.destroyed) return;
      const pcm = session.resampler.process(chunk);
      if (pcm.length && !input.write(pcm)) stdout.pause();
    });
    input.on('drain', () => {
      if (!session.destroyed) stdout.resume();
    });

    session.player = createAudioPlayer({
      behaviors: {
        // Keep decoding even if nobody is connected; Spotify keeps playing.
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: Math.round(5000 / 20),
      },
    });

    wirePlayerEvents(session, guildId);

    const resource = createAudioResource(session.mixer, {
      inputType: StreamType.Raw, // s16le / 48 kHz / stereo
      silencePaddingFrames: 5,
    });

    session.player.play(resource);
    session.connection.subscribe(session.player);

    console.log(`[session:${guildId}] ready — device "${config.librespot.deviceName}" is now visible in Spotify Connect`);
    emitStatus();
    return { created: true };
  } catch (err) {
    // Any failure during setup must not leak processes or connections.
    destroySession(guildId);
    throw err;
  }
}

/**
 * Tear down a guild's session: kill child processes, stop the player and
 * destroy the voice connection. Safe to call multiple times.
 *
 * @param {string} guildId
 * @returns {boolean} true if a session existed and was destroyed.
 */
function destroySession(guildId) {
  const session = sessions.get(guildId);
  if (!session || session.destroyed) return false;
  session.destroyed = true;
  sessions.delete(guildId);

  console.log(`[session:${guildId}] tearing down`);

  // Stop the player first so @discordjs/voice releases the stream.
  try {
    session.player?.stop(true);
  } catch { /* already stopped */ }

  try {
    session.mixer?.destroy();
  } catch { /* stream already closed */ }

  // Stop reading before the kill; the 'data' handler also checks destroyed.
  try {
    session.librespot?.stdout?.removeAllListeners('data');
    session.librespot?.stdout?.pause();
  } catch { /* stream already closed */ }

  killProcess(session.librespot, 'librespot');

  try {
    if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
  } catch { /* connection already destroyed */ }

  emitStatus();
  return true;
}

/** @param {string} guildId */
function hasSession(guildId) {
  return sessions.has(guildId);
}

/** Destroy every session — used for graceful shutdown. */
function destroyAll() {
  for (const guildId of [...sessions.keys()]) {
    destroySession(guildId);
  }
}

/* ───────────────────────── soundboard API ─────────────────────────
 * Single-guild by design: these operate on "the" active session. */

/** @returns {Session|null} the first (only) live session. */
function getActiveSession() {
  for (const session of sessions.values()) {
    if (!session.destroyed && session.mixer) return session;
  }
  return null;
}

/**
 * Play a soundboard clip through the active session, muting Spotify
 * underneath it. Replaces any clip already playing.
 * @param {{id: string|number, name: string, buffer: Buffer}} clip raw s16le/48k/stereo PCM
 * @returns {boolean} false when the bot is not in a voice channel.
 */
function playClip(clip) {
  const session = getActiveSession();
  if (!session) return false;
  session.mixer.playClip(clip);
  return true;
}

/** Stop the active clip. @returns {boolean} */
function stopClip() {
  const session = getActiveSession();
  if (!session) return false;
  return session.mixer.stopClip();
}

/** Set the music-only volume (0-100); clips are unaffected. */
function setMusicVolume(value) {
  const v = Math.min(100, Math.max(0, Math.round(Number(value))));
  if (!Number.isFinite(v)) return musicVolume;
  musicVolume = v;
  getActiveSession()?.mixer.setMusicVolume(v / 100);
  emitStatus();
  return musicVolume;
}

/** Instantly mute/unmute music (unmuting also cancels a pause mute). */
function setSpotifyMuted(muted) {
  const session = getActiveSession();
  if (!session) return false;
  session.mixer.setMusicMuted(muted);
  return true;
}

/** Pause mute: silent until librespot has actually stopped (see Mixer). */
function muteSpotifyUntilQuiet() {
  const session = getActiveSession();
  if (!session) return false;
  session.mixer.muteUntilQuiet();
  return true;
}

/** Status snapshot for /api/status and WS broadcasts. */
function getStatus() {
  const session = getActiveSession();
  if (!session) {
    return { inVoice: false, clip: null, spotifyActive: false, musicVolume };
  }
  const guildId = [...sessions.keys()].find((id) => sessions.get(id) === session) ?? null;
  return { inVoice: true, guildId, musicVolume, ...session.mixer.getState() };
}

function emitStatus() {
  events.emit('status', getStatus());
}

/* ───────────────────────── internal wiring ───────────────────────── */

/**
 * Gracefully kill a child process: SIGTERM first, SIGKILL if it lingers.
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {string} label
 */
function killProcess(child, label) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        console.warn(`[${label}] did not exit after SIGTERM, sending SIGKILL`);
        child.kill('SIGKILL');
      }
    }, 3000);
    timer.unref(); // never keep the event loop alive for this
  } catch (err) {
    console.error(`[${label}] error while killing process: ${err.message}`);
  }
}

/**
 * Attach stream/process error handlers so a dying child process tears the
 * session down cleanly instead of crashing Node with an unhandled 'error'.
 * @param {Session} session
 * @param {string} guildId
 */
function wireProcessEvents(session, guildId) {
  const { librespot } = session;

  librespot.on('error', (err) => {
    // e.g. ENOENT when the binary path is wrong
    console.error(`[librespot] failed to start: ${err.message}`);
    destroySession(guildId);
  });

  librespot.on('exit', (code, signal) => {
    console.log(`[librespot] exited (code=${code}, signal=${signal})`);
    if (!session.destroyed) destroySession(guildId);
  });

  librespot.stdout.on('error', (err) => {
    console.error(`[librespot] stdout error: ${err.message}`);
  });
}

/**
 * Handle voice connection state transitions, including Discord-initiated
 * disconnects (kicks, region moves) with a bounded reconnect attempt.
 * @param {Session} session
 * @param {string} guildId
 */
function wireConnectionEvents(session, guildId) {
  const connection = session.connection;

  connection.on('error', (err) => {
    console.error(`[connection:${guildId}] error: ${err.message}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async (_, newState) => {
    // A 4014 close with WebSocket reason may be a channel move — give the
    // library a chance to resume before declaring the session dead.
    if (
      newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      newState.closeCode === 4014
    ) {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        return; // moved channel / reconnecting — keep session alive
      } catch {
        destroySession(guildId); // actually kicked
        return;
      }
    }

    // Otherwise attempt a normal automatic reconnect.
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(guildId);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (!session.destroyed) destroySession(guildId);
  });
}

/**
 * Player diagnostics. An erroring resource must not take the process down.
 * @param {Session} session
 * @param {string} guildId
 */
function wirePlayerEvents(session, guildId) {
  session.player.on('error', (err) => {
    console.error(`[player:${guildId}] error: ${err.message}`);
    // The mixer stream itself is dead; librespot's exit handler or the
    // connection handlers trigger the actual teardown.
  });

  session.player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[player:${guildId}] streaming audio`);
  });

  session.player.on(AudioPlayerStatus.Idle, () => {
    // Idle just means librespot is silent (paused / between tracks).
    console.log(`[player:${guildId}] idle (no PCM from Spotify)`);
  });
}

module.exports = {
  createSession,
  destroySession,
  hasSession,
  destroyAll,
  getActiveSession,
  playClip,
  stopClip,
  setMusicVolume,
  setSpotifyMuted,
  muteSpotifyUntilQuiet,
  getStatus,
  events,
};
