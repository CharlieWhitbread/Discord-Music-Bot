'use strict';

/**
 * mixer
 * ─────
 * Frame-based priority switcher that replaces the old PassThrough +
 * silence-timer stage. It is the single realtime pacer of the pipeline:
 *
 *   ffmpeg stdout ──pipe──▶ mixer.spotifyInput (Writable, capped buffer)
 *                                │  backpressure paces librespot
 *                                ▼
 *                         20 ms frame clock
 *                                │  Spotify frame | clip frame | silence
 *                                ▼
 *                     Mixer (Readable) ──▶ AudioResource (StreamType.Raw)
 *
 * Invariants honoured here (see CLAUDE.md):
 *  - Spotify PCM is consumed at realtime rate even while a clip plays
 *    (read & discarded), so librespot's pacing never stalls.
 *  - A frame is pushed every 20 ms no matter what (silence when neither
 *    source has data), so the AudioPlayer never goes idle.
 *  - While a clip plays the Spotify samples are attenuated to 0 (mute),
 *    with a short gain ramp on both edges to avoid clicks.
 */

const { Readable, Writable } = require('node:stream');

// 20 ms of s16le / 48 kHz / stereo: 48000 * 2ch * 2B * 0.02
const FRAME_BYTES = 3840;
const SAMPLES_PER_FRAME = FRAME_BYTES / 2; // Int16 samples (both channels)
const FRAME_MS = 20;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

// Spotify buffer cap: keeps browser-press→Discord latency bounded while
// still giving librespot/ffmpeg room to write bursts.
const SPOTIFY_BUFFER_HIGH = FRAME_BYTES * 12; // 240 ms
const SPOTIFY_BUFFER_LOW = FRAME_BYTES * 6;

// Gain ramp applied to Spotify audio around clip boundaries (frames).
const FADE_FRAMES = 3; // 60 ms
const GAIN_STEP = 1 / FADE_FRAMES;

// After an event-loop stall, don't burst more than this many frames;
// resynchronise the clock instead (drops the backlog).
const MAX_FRAMES_PER_TICK = 5;

class Mixer extends Readable {
  /** @param {string} label log prefix, e.g. the guild id */
  constructor(label) {
    super({ highWaterMark: 1 << 16 });
    this.label = label;

    /** @type {{id: string|number, name: string, buffer: Buffer, offset: number}|null} */
    this.clip = null;
    this.lastSpotifyDataAt = 0;

    this._spotifyChunks = [];
    this._spotifyBuffered = 0;
    this._pendingWriteCb = null;
    this._spotifyGain = 1; // 1 = full Spotify, 0 = muted under a clip
    this._framesSent = 0;
    this._startedAt = null;
    this._timer = null;

    const mixer = this;
    /** Writable side for the ffmpeg → mixer pipe. */
    this.spotifyInput = new Writable({
      highWaterMark: 1 << 14,
      write(chunk, _enc, cb) {
        mixer._spotifyChunks.push(chunk);
        mixer._spotifyBuffered += chunk.length;
        mixer.lastSpotifyDataAt = Date.now();
        // Delay the ack while over the cap — this is the backpressure that
        // paces librespot (its pipe backend has no clock of its own).
        if (mixer._spotifyBuffered > SPOTIFY_BUFFER_HIGH) {
          mixer._pendingWriteCb = cb;
        } else {
          cb();
        }
      },
    });
    this.spotifyInput.on('error', (err) => {
      console.error(`[mixer:${this.label}] spotify input error: ${err.message}`);
    });

    this._startClock();
  }

  /* ─────────────────────────── public API ─────────────────────────── */

  /**
   * Start (or replace) the active soundboard clip.
   * @param {{id: string|number, name: string, buffer: Buffer}} clip
   *   buffer must be raw s16le / 48 kHz / stereo PCM.
   */
  playClip({ id, name, buffer }) {
    const replaced = this.clip !== null;
    this.clip = { id, name, buffer, offset: 0 };
    this.emit('clipstart', { id, name, replaced });
  }

  /** Stop the active clip, if any. @returns {boolean} */
  stopClip() {
    if (!this.clip) return false;
    const { id, name } = this.clip;
    this.clip = null;
    this.emit('clipend', { id, name, stopped: true });
    return true;
  }

  /** Snapshot for /api/status and WS broadcasts. */
  getState() {
    return {
      clip: this.clip ? { id: this.clip.id, name: this.clip.name } : null,
      spotifyActive: Date.now() - this.lastSpotifyDataAt < 1000,
    };
  }

  _destroy(err, cb) {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    // Release a parked ffmpeg write so the pipe can unwind during teardown.
    if (this._pendingWriteCb) {
      const pending = this._pendingWriteCb;
      this._pendingWriteCb = null;
      pending();
    }
    this.spotifyInput.destroy();
    cb(err);
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  _read() { /* frames are pushed by the clock, not pulled */ }

  _startClock() {
    this._startedAt = Date.now();
    this._framesSent = 0;
    this._timer = setInterval(() => this._tick(), FRAME_MS);
    // Never keep the process alive for the mixer alone.
    this._timer.unref?.();
  }

  _tick() {
    if (this.destroyed) return;
    const owed = Math.floor((Date.now() - this._startedAt) / FRAME_MS) - this._framesSent;
    if (owed <= 0) return;
    const n = Math.min(owed, MAX_FRAMES_PER_TICK);
    for (let i = 0; i < n; i++) {
      this._emitFrame();
      this._framesSent++;
    }
    if (owed > MAX_FRAMES_PER_TICK) {
      // Event-loop stall: drop the backlog rather than bursting audio.
      this._framesSent = Math.floor((Date.now() - this._startedAt) / FRAME_MS);
    }
  }

  _emitFrame() {
    // Always consume a Spotify frame if available — even when muted — so
    // librespot keeps being paced at realtime.
    const spotifyFrame = this._takeSpotifyFrame();

    // Ramp Spotify gain toward its target (0 under a clip, 1 otherwise).
    const targetGain = this.clip ? 0 : 1;
    if (this._spotifyGain < targetGain) {
      this._spotifyGain = Math.min(1, this._spotifyGain + GAIN_STEP);
    } else if (this._spotifyGain > targetGain) {
      this._spotifyGain = Math.max(0, this._spotifyGain - GAIN_STEP);
    }

    let clipFrame = null;
    if (this.clip) {
      const { buffer, offset } = this.clip;
      const end = Math.min(offset + FRAME_BYTES, buffer.length);
      clipFrame = buffer.subarray(offset, end);
      this.clip.offset = end;
      if (end >= buffer.length) {
        const { id, name } = this.clip;
        this.clip = null;
        this.emit('clipend', { id, name, stopped: false });
      }
    }

    // Fast path: pure Spotify (or pure silence) with no ramp in progress.
    if (!clipFrame && this._spotifyGain === 1) {
      this.push(spotifyFrame ?? SILENCE_FRAME);
      return;
    }
    if (!clipFrame && this._spotifyGain === 0 && !spotifyFrame) {
      this.push(SILENCE_FRAME);
      return;
    }

    // Blend path: out = clip + spotify * gain, clamped to Int16.
    const out = Buffer.alloc(FRAME_BYTES);
    const gain = this._spotifyGain;
    for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
      let sample = 0;
      if (spotifyFrame && gain > 0) sample += spotifyFrame.readInt16LE(i * 2) * gain;
      if (clipFrame && i * 2 + 1 < clipFrame.length) sample += clipFrame.readInt16LE(i * 2);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      out.writeInt16LE(sample | 0, i * 2);
    }
    this.push(out);
  }

  /** @returns {Buffer|null} one full frame of Spotify PCM, or null. */
  _takeSpotifyFrame() {
    if (this._spotifyBuffered < FRAME_BYTES) return null;

    let frame;
    const first = this._spotifyChunks[0];
    if (first.length === FRAME_BYTES) {
      frame = this._spotifyChunks.shift();
    } else if (first.length > FRAME_BYTES) {
      frame = first.subarray(0, FRAME_BYTES);
      this._spotifyChunks[0] = first.subarray(FRAME_BYTES);
    } else {
      frame = Buffer.allocUnsafe(FRAME_BYTES);
      let filled = 0;
      while (filled < FRAME_BYTES) {
        const chunk = this._spotifyChunks[0];
        const take = Math.min(chunk.length, FRAME_BYTES - filled);
        chunk.copy(frame, filled, 0, take);
        filled += take;
        if (take === chunk.length) this._spotifyChunks.shift();
        else this._spotifyChunks[0] = chunk.subarray(take);
      }
    }
    this._spotifyBuffered -= FRAME_BYTES;

    // Drained below the low-water mark — let ffmpeg resume writing.
    if (this._pendingWriteCb && this._spotifyBuffered <= SPOTIFY_BUFFER_LOW) {
      const cb = this._pendingWriteCb;
      this._pendingWriteCb = null;
      cb();
    }
    return frame;
  }
}

module.exports = { Mixer, FRAME_BYTES };
