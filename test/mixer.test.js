'use strict';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Mixer, FRAME_BYTES } = require('../src/audio/mixer');

const FRAME_MS = 20;

/** A frame whose every Int16 sample is `value`. */
function constFrame(value, frames = 1) {
  const buf = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(value, i);
  return buf;
}

const firstSample = (frame) => frame.readInt16LE(0);
const isSilent = (frame) => frame.every((b) => b === 0);

let mixer;
let frames;

beforeEach(() => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  mixer = new Mixer('test');
  frames = [];
});

afterEach(() => {
  mixer.destroy();
  mock.timers.reset();
});

/** Advance the 20 ms clock by n frames, collecting what the mixer pushed. */
function tickFrames(n) {
  for (let i = 0; i < n; i++) {
    mock.timers.tick(FRAME_MS);
    collect();
  }
}

/** Paused-mode reads are synchronous ('data' would only flow next tick). */
function collect() {
  let chunk;
  while ((chunk = mixer.read(FRAME_BYTES)) !== null) frames.push(chunk);
}

/** Write to spotifyInput and report whether the write was acked. */
function write(buf) {
  let acked = false;
  mixer.spotifyInput.write(buf, () => { acked = true; });
  return () => acked;
}

describe('frame clock', () => {
  test('emits exactly one 3840-byte frame per 20 ms', () => {
    tickFrames(10);
    assert.equal(frames.length, 10);
    for (const f of frames) assert.equal(f.length, FRAME_BYTES);
  });

  test('pushes silence when there is no input, so the player never idles', () => {
    tickFrames(5);
    assert.equal(frames.length, 5);
    assert.ok(frames.every(isSilent));
  });

  test('passes Spotify PCM through unchanged at unity gain', () => {
    mixer.spotifyInput.write(constFrame(1234, 2));
    tickFrames(3);
    assert.equal(firstSample(frames[0]), 1234);
    assert.equal(firstSample(frames[1]), 1234);
    assert.ok(isSilent(frames[2]), 'runs dry → silence');
  });

  test('reassembles frames from odd-sized chunks', () => {
    const whole = Buffer.alloc(FRAME_BYTES * 2);
    for (let i = 0; i < whole.length; i += 2) whole.writeInt16LE(i % 30000, i);
    mixer.spotifyInput.write(whole.subarray(0, 1000));
    mixer.spotifyInput.write(whole.subarray(1000, 5000));
    mixer.spotifyInput.write(whole.subarray(5000));
    tickFrames(2);
    assert.deepEqual(Buffer.concat(frames), whole);
  });

  test('an event-loop stall emits at most 5 frames, then resynchronises', () => {
    tickFrames(1);
    assert.equal(frames.length, 1);
    // Stall: the clock jumps 1 s without the interval running.
    mock.timers.setTime(Date.now() + 1000);
    tickFrames(1);
    assert.equal(frames.length, 1 + 5, 'burst capped at MAX_FRAMES_PER_TICK');
    tickFrames(1);
    assert.equal(frames.length, 1 + 5 + 1, 'back to one frame per tick (backlog dropped)');
  });
});

describe('Spotify backpressure', () => {
  test('parks the write callback above 240 ms and releases it at ≤120 ms', async () => {
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const acks = [];
    for (let i = 0; i < 12; i++) acks.push(write(constFrame(1)));
    await turn();
    assert.ok(acks.every((a) => a()), '12 frames = exactly the high-water mark: acked');

    const parked = write(constFrame(1));
    await turn();
    assert.equal(parked(), false, '13th frame exceeds the cap: ack withheld (paces librespot)');

    tickFrames(6); // 13 → 7 frames buffered, still above the low-water mark
    await turn();
    assert.equal(parked(), false);
    tickFrames(1); // 6 frames = low-water mark
    await turn();
    assert.equal(parked(), true, 'drained to the low-water mark: ffmpeg may write again');
  });

  test('keeps consuming Spotify PCM while a clip plays (invariant 1)', async () => {
    for (let i = 0; i < 12; i++) mixer.spotifyInput.write(constFrame(500));
    const parked = write(constFrame(500));
    mixer.playClip({ id: 1, name: 'c', buffer: constFrame(0, 50) });
    tickFrames(7);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parked(), true, 'Spotify was read (and discarded) under the clip');
    assert.equal(mixer._spotifyBuffered, FRAME_BYTES * 6);
  });

  test('destroy() releases a parked write so the pipe can unwind', async () => {
    for (let i = 0; i < 12; i++) mixer.spotifyInput.write(constFrame(1));
    const parked = write(constFrame(1));
    assert.ok(mixer._pendingWriteCb, 'write is parked');
    mixer.destroy();
    assert.equal(mixer._pendingWriteCb, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parked(), true);
  });
});

describe('clips', () => {
  test('ramps Spotify down over 3 frames under a clip and back up after it', () => {
    mixer.spotifyInput.write(constFrame(3000, 12));
    mixer.playClip({ id: 1, name: 'silent', buffer: constFrame(0, 4) });
    tickFrames(4); // clip frames
    tickFrames(4); // after the clip
    const levels = frames.map(firstSample);
    assert.deepEqual(levels, [2000, 1000, 0, 0, 1000, 2000, 3000, 3000]);
  });

  test('blends clip on top of the ramping Spotify signal and clamps to Int16', () => {
    mixer.spotifyInput.write(constFrame(30000, 2));
    mixer.playClip({ id: 1, name: 'loud', buffer: constFrame(30000, 2) });
    tickFrames(1);
    assert.equal(firstSample(frames[0]), 32767, '20000 + 30000 clamps');

    mixer.destroy();
    mixer = new Mixer('neg');
    frames = [];
    mixer.spotifyInput.write(constFrame(-30000, 1));
    mixer.playClip({ id: 2, name: 'loud', buffer: constFrame(-30000, 1) });
    tickFrames(1);
    assert.equal(firstSample(frames[0]), -32768);
  });

  test('emits clipstart (with replaced flag) and clipend when the clip runs out', () => {
    const events = [];
    mixer.on('clipstart', (e) => events.push(['start', e]));
    mixer.on('clipend', (e) => events.push(['end', e]));
    mixer.playClip({ id: 1, name: 'a', buffer: constFrame(100, 2) });
    mixer.playClip({ id: 2, name: 'b', buffer: constFrame(100, 2) });
    tickFrames(3);
    assert.deepEqual(events, [
      ['start', { id: 1, name: 'a', replaced: false }],
      ['start', { id: 2, name: 'b', replaced: true }],
      ['end', { id: 2, name: 'b', stopped: false }],
    ]);
    assert.equal(mixer.getState().clip, null);
  });

  test('a partial last clip frame is zero-padded to a full frame', () => {
    mixer.playClip({ id: 1, name: 'short', buffer: constFrame(700).subarray(0, 1000) });
    tickFrames(1);
    assert.equal(frames[0].length, FRAME_BYTES);
    assert.equal(frames[0].readInt16LE(0), 700);
    assert.equal(frames[0].readInt16LE(998), 700);
    assert.equal(frames[0].readInt16LE(1000), 0);
  });

  test('stopClip emits clipend {stopped: true} and is a no-op without a clip', () => {
    const ends = [];
    mixer.on('clipend', (e) => ends.push(e));
    assert.equal(mixer.stopClip(), false);
    mixer.playClip({ id: 9, name: 'x', buffer: constFrame(1, 10) });
    assert.equal(mixer.stopClip(), true);
    assert.deepEqual(ends, [{ id: 9, name: 'x', stopped: true }]);
  });
});

describe('volume and local mute', () => {
  test('volume ramps 1/3 per frame and is clamped to 0..1', () => {
    mixer.spotifyInput.write(constFrame(3000, 8));
    mixer.setMusicVolume(-5);
    tickFrames(4);
    assert.deepEqual(frames.map(firstSample), [2000, 1000, 0, 0]);
    mixer.setMusicVolume(7);
    tickFrames(4);
    assert.deepEqual(frames.slice(4).map(firstSample), [1000, 2000, 3000, 3000]);
  });

  test('setMusicMuted fades music out without affecting clips', () => {
    mixer.spotifyInput.write(constFrame(3000, 6));
    mixer.setMusicMuted(true);
    tickFrames(4);
    assert.deepEqual(frames.map(firstSample), [2000, 1000, 0, 0]);
    assert.equal(mixer.getState().musicMuted, true);
    mixer.playClip({ id: 1, name: 'c', buffer: constFrame(1500, 1) });
    tickFrames(1);
    assert.equal(firstSample(frames[4]), 1500);
  });
});

describe('pause mute (muteUntilQuiet)', () => {
  /** librespot still playing: keep feeding the input every frame. */
  function feedWhile(n, value = 3000) {
    for (let i = 0; i < n; i++) {
      mixer.spotifyInput.write(constFrame(value));
      tickFrames(1);
    }
  }

  test('stays muted while librespot keeps writing — the buffered tail is never heard', () => {
    const unmutes = [];
    mixer.on('quietunmute', (r) => unmutes.push(r));
    feedWhile(3);
    mixer.muteUntilQuiet();
    feedWhile(100); // 2 s of tail still arriving, far past the old fixed 2 s mute
    assert.ok(frames.slice(6).every(isSilent), 'nothing audible after the fade');
    assert.deepEqual(unmutes, []);
    assert.equal(mixer.getState().musicMuted, true);
  });

  test('unmutes once the input has been quiet, dropping what is still buffered', () => {
    const unmutes = [];
    mixer.on('quietunmute', (r) => unmutes.push(r));
    mixer.spotifyInput.write(constFrame(3000, 30)); // 600 ms tail in one last big write
    mixer.muteUntilQuiet();
    tickFrames(19); // 380 ms of quiet
    assert.deepEqual(unmutes, []);
    tickFrames(2);
    assert.deepEqual(unmutes, ['quiet']);
    assert.equal(mixer._spotifyBuffered, 0, 'unheard tail dropped, not played after the unmute');
    assert.equal(mixer.getState().musicMuted, false);
    // Resumed music is audible again.
    feedWhile(4, 2000);
    assert.equal(firstSample(frames.at(-1)), 2000);
  });

  test('a parked upstream write is released when the tail is dropped', () => {
    const acked = write(constFrame(3000, 20)); // over the 240 ms cap → parked
    assert.equal(acked(), false);
    mixer.muteUntilQuiet();
    tickFrames(25);
    assert.equal(acked(), true);
  });

  test('gives up after 8 s if music keeps flowing (pause failed / resumed elsewhere)', () => {
    const unmutes = [];
    mixer.on('quietunmute', (r) => unmutes.push(r));
    mixer.muteUntilQuiet();
    feedWhile(8000 / FRAME_MS + 2);
    assert.deepEqual(unmutes, ['timeout']);
    assert.equal(mixer.getState().musicMuted, false);
  });

  test('setMusicMuted(false) (resume) cancels it immediately', () => {
    const unmutes = [];
    mixer.on('quietunmute', (r) => unmutes.push(r));
    mixer.muteUntilQuiet();
    mixer.setMusicMuted(false);
    tickFrames(30);
    assert.deepEqual(unmutes, [], 'no later auto-unmute event');
    assert.equal(mixer.getState().musicMuted, false);
  });
});

describe('state and teardown', () => {
  test('getState reports spotifyActive for 1 s after the last write', () => {
    assert.equal(mixer.getState().spotifyActive, false);
    mixer.spotifyInput.write(constFrame(1));
    assert.equal(mixer.getState().spotifyActive, true);
    mock.timers.tick(1001);
    assert.equal(mixer.getState().spotifyActive, false);
  });

  test('destroy() clears the clock: no timers left, no frames after', () => {
    tickFrames(2);
    mixer.destroy();
    assert.equal(mixer._timer, null);
    assert.equal(mixer.spotifyInput.destroyed, true);
    const before = frames.length;
    tickFrames(10);
    assert.equal(frames.length, before);
  });
});
