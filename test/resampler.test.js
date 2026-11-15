'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Resampler } = require('../src/audio/resampler');

/** Stereo s16le @ 44.1 kHz: left = sine at freq, right = inverted. */
function tone(freq, seconds, amp = 12000) {
  const n = Math.round(44100 * seconds);
  const buf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / 44100));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(-v, i * 4 + 2);
  }
  return buf;
}

function resampleInChunks(input, chunkSize) {
  const r = new Resampler();
  const out = [];
  for (let o = 0; o < input.length; o += chunkSize) out.push(r.process(input.subarray(o, o + chunkSize)));
  return Buffer.concat(out);
}

/** Least-squares sine fit at freq on one channel (after filter warm-up). */
function fit(buf, freq, channel = 0) {
  const frames = buf.length / 4;
  const from = 500;
  const to = frames - 500;
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
  const y = (i) => buf.readInt16LE(i * 4 + channel * 2);
  for (let i = from; i < to; i++) {
    const t = (2 * Math.PI * freq * i) / 48000;
    const s = Math.sin(t);
    const c = Math.cos(t);
    ss += s * s; cc += c * c; sc += s * c; ys += y(i) * s; yc += y(i) * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det;
  const b = (yc * ss - ys * sc) / det;
  let err = 0;
  let power = 0;
  for (let i = from; i < to; i++) {
    const t = (2 * Math.PI * freq * i) / 48000;
    const f = a * Math.sin(t) + b * Math.cos(t);
    err += (y(i) - f) ** 2;
    power += f * f;
  }
  return { amp: Math.hypot(a, b), snrDb: 10 * Math.log10(power / err) };
}

describe('Resampler 44.1 → 48 kHz', () => {
  test('produces exactly 160/147 as many frames, even across odd chunk splits', () => {
    const input = tone(440, 1); // 44100 frames
    for (const size of [4, 7, 1001, 4099, 16384]) {
      assert.equal(resampleInChunks(input, size).length / 4, 48000, `chunk size ${size}`);
    }
  });

  test('output does not depend on how the input was chunked', () => {
    const input = tone(1000, 0.25);
    const whole = resampleInChunks(input, input.length);
    assert.ok(whole.equals(resampleInChunks(input, 3)), 'split mid-frame');
    assert.ok(whole.equals(resampleInChunks(input, 4096)));
  });

  for (const freq of [100, 1000, 10000, 18000]) {
    test(`a ${freq} Hz tone keeps its frequency and level, > 75 dB SNR, both channels`, () => {
      const out = resampleInChunks(tone(freq, 1), 4096);
      for (const ch of [0, 1]) {
        const { amp, snrDb } = fit(out, freq, ch);
        assert.ok(Math.abs(amp - 12000) < 12000 * 0.02, `amp ${amp}`); // ±0.17 dB, incl. rolloff near the cutoff
        assert.ok(snrDb > 75, `SNR ${snrDb.toFixed(1)} dB`);
      }
    });
  }

  test('full-scale input clamps instead of wrapping', () => {
    const out = resampleInChunks(tone(1000, 0.2, 32767), 4096);
    for (let i = 0; i < out.length; i += 2) {
      const v = out.readInt16LE(i);
      assert.ok(v >= -32768 && v <= 32767);
    }
    // A wrap would show as a huge sample-to-sample jump on a 1 kHz tone.
    let maxStep = 0;
    for (let i = 4; i < out.length; i += 4) maxStep = Math.max(maxStep, Math.abs(out.readInt16LE(i) - out.readInt16LE(i - 4)));
    assert.ok(maxStep < 8000, `max step ${maxStep}`);
  });

  test('reset() forgets history: same input → same output as a fresh instance', () => {
    const r = new Resampler();
    r.process(tone(5000, 0.1));
    r.process(Buffer.from([1, 2, 3])); // leaves a partial frame behind
    r.reset();
    const input = tone(700, 0.1);
    assert.ok(r.process(input).equals(new Resampler().process(input)));
  });

  test('empty and sub-frame chunks are fine', () => {
    const r = new Resampler();
    assert.equal(r.process(Buffer.alloc(0)).length, 0);
    assert.equal(r.process(Buffer.alloc(3)).length, 0);
    assert.ok(r.process(Buffer.alloc(1)).length > 0, 'completes the frame');
  });
});
