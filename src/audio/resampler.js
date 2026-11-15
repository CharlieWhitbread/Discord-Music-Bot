'use strict';

/**
 * resampler
 * ─────────
 * Streaming 44.1 kHz → 48 kHz resampler for interleaved stereo s16le PCM,
 * so librespot's output can feed the mixer without an ffmpeg process in
 * between. ffmpeg sat between two OS pipes and its own internal buffers;
 * librespot (which has no clock and runs as far ahead as the buffers allow)
 * ended up seconds ahead of what Discord was playing. Every pause, skip and
 * reported position was off by that much. In-process, the only buffering
 * left is one OS pipe plus the mixer's capped input.
 *
 * Polyphase windowed-sinc: 48000/44100 = 160/147 exactly, so each output
 * sample uses one of 160 precomputed filter phases of TAPS taps. Cutoff
 * sits just under the input Nyquist (22.05 kHz); a Kaiser window gives
 * > 80 dB stopband, well past what Opus keeps.
 */

const L = 160; // upsample factor
const M = 147; // downsample factor
const TAPS = 32; // per phase
const CHANNELS = 2;
const BYTES_PER_FRAME = 2 * CHANNELS;
const CUTOFF = 0.94; // fraction of the input Nyquist
const KAISER_BETA = 8.6;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

/** phases[p][k] multiplies x[i - k] for output phase p (gain included). */
function buildPhases() {
  const len = L * TAPS;
  const center = (len - 1) / 2;
  const fc = (0.5 * CUTOFF) / L; // cycles per upsampled sample
  const i0Beta = besselI0(KAISER_BETA);
  const h = new Float64Array(len);
  for (let j = 0; j < len; j++) {
    const t = j - center;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const r = (2 * j) / (len - 1) - 1;
    h[j] = sinc * (besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta);
  }
  const phases = [];
  for (let p = 0; p < L; p++) {
    const taps = new Float32Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      taps[k] = h[p + k * L];
      sum += taps[k];
    }
    // Normalise each phase to unity DC gain so no phase ripples in level.
    for (let k = 0; k < TAPS; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
}

const PHASES = buildPhases();
const HISTORY = TAPS - 1;

class Resampler {
  constructor() {
    // Per-channel input samples: HISTORY carried over + the current chunk.
    this._left = new Float32Array(0);
    this._right = new Float32Array(0);
    this._histL = new Float32Array(HISTORY);
    this._histR = new Float32Array(HISTORY);
    // Position of the next output sample, in 1/L input-sample units,
    // relative to the start of (history + chunk).
    this._pos = HISTORY * L;
    this._carry = Buffer.alloc(0); // partial frame left over from a chunk
  }

  /**
   * @param {Buffer} chunk s16le stereo @ 44.1 kHz (any length)
   * @returns {Buffer} s16le stereo @ 48 kHz
   */
  process(chunk) {
    let input = chunk;
    if (this._carry.length) input = Buffer.concat([this._carry, chunk]);
    const frames = Math.floor(input.length / BYTES_PER_FRAME);
    this._carry = Buffer.from(input.subarray(frames * BYTES_PER_FRAME));
    if (frames === 0) return Buffer.alloc(0);

    const total = HISTORY + frames;
    if (this._left.length < total) {
      this._left = new Float32Array(total);
      this._right = new Float32Array(total);
    }
    const xl = this._left;
    const xr = this._right;
    xl.set(this._histL, 0);
    xr.set(this._histR, 0);
    for (let f = 0; f < frames; f++) {
      xl[HISTORY + f] = input.readInt16LE(f * 4);
      xr[HISTORY + f] = input.readInt16LE(f * 4 + 2);
    }

    // Output samples whose newest tap index (pos / L) is inside the chunk.
    const end = total * L;
    const count = Math.max(0, Math.ceil((end - this._pos) / M));
    const out = Buffer.allocUnsafe(count * BYTES_PER_FRAME);
    let pos = this._pos;
    for (let n = 0; n < count; n++) {
      const i = Math.floor(pos / L);
      const taps = PHASES[pos - i * L];
      let sl = 0;
      let sr = 0;
      for (let k = 0; k < TAPS; k++) {
        const c = taps[k];
        sl += c * xl[i - k];
        sr += c * xr[i - k];
      }
      out.writeInt16LE(clamp16(sl), n * 4);
      out.writeInt16LE(clamp16(sr), n * 4 + 2);
      pos += M;
    }

    this._histL.set(xl.subarray(total - HISTORY, total));
    this._histR.set(xr.subarray(total - HISTORY, total));
    this._pos = pos - frames * L;
    return out;
  }

  /** Drop all state (e.g. after discarding buffered audio). */
  reset() {
    this._histL.fill(0);
    this._histR.fill(0);
    this._pos = HISTORY * L;
    this._carry = Buffer.alloc(0);
  }
}

function clamp16(v) {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

module.exports = { Resampler, INPUT_RATE: 44100, OUTPUT_RATE: 48000 };
