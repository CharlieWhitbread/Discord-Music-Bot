'use strict';

/**
 * sessionManager
 * ──────────────
 * Owns the full audio pipeline for each guild:
 *
 *   librespot (child process, --backend pipe)
 *        │  raw PCM  s16le / 44100 Hz / 2ch  (stdout)
 *        ▼
 *   ffmpeg (child process)
 *        │  raw PCM  s16le / 48000 Hz / 2ch  (stdout)  ← Discord's required rate
 *        ▼
 *   AudioResource (StreamType.Raw) → AudioPlayer → VoiceConnection
 *
 * Every external resource (two child processes + one voice connection) is
 * tracked in a Session object so that teardown is always complete and
 * idempotent, no matter which component fails first.
 */

const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
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
const ffmpegPath = require('ffmpeg-static');
const config = require('../config');

/** @type {Map<string, Session>} guildId → active session */
const sessions = new Map();

// 20 ms of s16le silence at 48 kHz stereo: 48000 * 2ch * 2B * 0.02
const SILENCE_FRAME = Buffer.alloc(3840);
// Inject silence if no real PCM arrived within this window (Spotify paused).
const SILENCE_AFTER_MS = 200;

/**
 * @typedef {object} Session
 * @property {import('@discordjs/voice').VoiceConnection} connection
 * @property {import('@discordjs/voice').AudioPlayer} player
 * @property {import('node:child_process').ChildProcess|null} librespot
 * @property {import('node:child_process').ChildProcess|null} ffmpeg
 * @property {import('node:stream').PassThrough|null} output
 * @property {NodeJS.Timeout|null} silenceTimer
 * @property {boolean} destroyed  Guard flag making destroySession idempotent.
 */

/* ────────────────────────── child processes ────────────────────────── */

/**
 * Spawn librespot configured as a headless Spotify Connect receiver that
 * writes raw PCM to stdout.
 */
function spawnLibrespot() {
  const args = [
    '--name', config.librespot.deviceName,
    '--backend', 'pipe',
    '--format', 'S16', // signed 16-bit little-endian
    '--initial-volume', String(config.librespot.initialVolume),
    '--bitrate', '320',
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

/**
 * Spawn ffmpeg to resample librespot's 44.1 kHz PCM to the 48 kHz PCM that
 * Discord's Opus encoder expects. Both sides are raw s16le streams, so the
 * input format must be declared explicitly (raw PCM has no header).
 */
function spawnFfmpeg() {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // Input: raw PCM from librespot
    '-f', 's16le',
    '-ar', String(config.audio.inputSampleRate),
    '-ac', String(config.audio.channels),
    '-i', 'pipe:0',
    // Output: raw PCM for @discordjs/voice (StreamType.Raw)
    '-f', 's16le',
    '-ar', String(config.audio.outputSampleRate),
    '-ac', String(config.audio.channels),
    'pipe:1',
  ];

  const child = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[ffmpeg] ${line}`);
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
    ffmpeg: null,
    output: null,
    silenceTimer: null,
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

    /* 2 ─ Spawn the audio pipeline */
    session.librespot = spawnLibrespot();
    session.ffmpeg = spawnFfmpeg();

    wireProcessEvents(session, guildId);

    // librespot PCM → ffmpeg stdin. { end: false } is deliberate: librespot
    // pauses its output between tracks and we must not close ffmpeg's stdin
    // when that happens... but 'end' only fires on true stream end, so the
    // default is fine; we keep it explicit for clarity.
    session.librespot.stdout.pipe(session.ffmpeg.stdin);

    // Swallow EPIPE that occurs if ffmpeg dies while librespot is writing —
    // the process 'exit' handlers below perform the actual cleanup.
    session.ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        console.error(`[ffmpeg] stdin error: ${err.message}`);
      }
    });

    /* 3 ─ Build player + resource from a persistent, silence-padded stream.
     *
     * The resource must NOT read ffmpeg.stdout directly: when Spotify is
     * paused, librespot stops writing PCM, the player would go Idle and
     * @discordjs/voice would destroy the stream — breaking ffmpeg's pipe and
     * killing the whole session. Instead, ffmpeg writes into a PassThrough
     * we own, and a timer injects silence frames whenever real audio stops,
     * so the player never goes idle across pauses and track gaps. */
    session.output = new PassThrough({ highWaterMark: 1 << 16 });
    session.output.on('error', (err) => {
      console.error(`[output:${guildId}] stream error: ${err.message}`);
    });

    let lastDataAt = Date.now();
    session.ffmpeg.stdout.on('data', (chunk) => {
      lastDataAt = Date.now();
      if (!session.destroyed) session.output.write(chunk);
    });

    session.silenceTimer = setInterval(() => {
      if (!session.destroyed && Date.now() - lastDataAt > SILENCE_AFTER_MS) {
        session.output.write(SILENCE_FRAME);
      }
    }, 20);

    session.player = createAudioPlayer({
      behaviors: {
        // Keep decoding even if nobody is connected; Spotify keeps playing.
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: Math.round(5000 / 20),
      },
    });

    wirePlayerEvents(session, guildId);

    const resource = createAudioResource(session.output, {
      inputType: StreamType.Raw, // s16le / 48 kHz / stereo
      silencePaddingFrames: 5,
    });

    session.player.play(resource);
    session.connection.subscribe(session.player);

    console.log(`[session:${guildId}] ready — device "${config.librespot.deviceName}" is now visible in Spotify Connect`);
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

  if (session.silenceTimer) clearInterval(session.silenceTimer);

  // Stop the player first so @discordjs/voice releases the stream.
  try {
    session.player?.stop(true);
  } catch { /* already stopped */ }

  try {
    session.output?.destroy();
  } catch { /* stream already closed */ }

  // Unpipe before killing to avoid write-after-end errors.
  try {
    session.librespot?.stdout?.unpipe();
  } catch { /* stream already closed */ }

  killProcess(session.librespot, 'librespot');
  killProcess(session.ffmpeg, 'ffmpeg');

  try {
    if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
  } catch { /* connection already destroyed */ }

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
  const { librespot, ffmpeg } = session;

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

  ffmpeg.on('error', (err) => {
    console.error(`[ffmpeg] failed to start: ${err.message}`);
    destroySession(guildId);
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`[ffmpeg] exited (code=${code}, signal=${signal})`);
    if (!session.destroyed) destroySession(guildId);
  });

  ffmpeg.stdout.on('error', (err) => {
    console.error(`[ffmpeg] stdout error: ${err.message}`);
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
    // The underlying ffmpeg stream is dead; process exit handlers will
    // trigger the actual teardown. Nothing else to do here.
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
};
