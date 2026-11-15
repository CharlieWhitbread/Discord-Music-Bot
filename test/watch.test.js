'use strict';

const { setupEnv, freshRequire, flush, advance, captureConsole } = require('./helpers/env');
const { FakeSpotify } = require('./helpers/fakeSpotify');

setupEnv();

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const alice = { userId: 'alice', username: 'Alice' };
const bob = { userId: 'bob', username: 'Bob' };
const V1 = 'dQw4w9WgXcQ';
const V2 = 'aaaaaaaaaaa';
const V3 = 'bbbbbbbbbbb';

let fake;
let watch;
let updates;

beforeEach((t) => {
  captureConsole(t);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000_000 });
  fake = new FakeSpotify().install(); // only its oEmbed stub is used here
  watch = freshRequire('server/watch.js');
  updates = [];
  watch.events.on('update', (s) => updates.push(s));
});

afterEach(() => {
  watch.stop();
  fake.uninstall();
  mock.timers.reset();
});

const pos = () => {
  const s = watch.get();
  return s.playing ? s.position + (Date.now() - s.updatedAt) / 1000 : s.position;
};

describe('load / oEmbed', () => {
  test('loads a video with its title and anchors at 0', async () => {
    await watch.load(V1, alice);
    const s = watch.get();
    assert.equal(s.videoId, V1);
    assert.equal(s.title, `Video ${V1}`);
    assert.equal(s.playing, true);
    assert.equal(s.position, 0);
    assert.equal(s.updatedAt, Date.now());
    assert.deepEqual(s.by, alice);
    assert.equal(s.action, 'load');
    assert.equal(updates.length, 1);
  });

  for (const bad of [undefined, null, 42, '', 'short', 'dQw4w9WgXcQx', '../../etc/x', 'dQw4w9WgX?Q', { id: V1 }]) {
    test(`rejects invalid id ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(watch.load(bad, alice), (e) => e.expose && /Invalid YouTube video/.test(e.message));
      assert.equal(fake.oembedCalls.length, 0, 'never reaches YouTube');
    });
  }

  test('embedding disabled (401/403) and missing (400/404) are rejected up front', async () => {
    for (const [status, re] of [[401, /embedded/], [403, /embedded/], [400, /not found/], [404, /not found/]]) {
      fake.oembed = () => ({ status, body: {} });
      await assert.rejects(watch.load(V1, alice), (e) => e.expose && re.test(e.message));
    }
    assert.equal(watch.get().videoId, null);
  });

  test('YouTube trouble (5xx, timeout, bad JSON) still loads, without a title', async () => {
    for (const oembed of [
      () => ({ status: 503, body: {} }),
      () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
      () => new Response('not json', { status: 200 }),
      () => ({ status: 200, body: { title: 12345 } }),
    ]) {
      fake.oembed = oembed;
      await watch.load(V1, alice);
      assert.equal(watch.get().title, null);
    }
  });

  test('the lookup is bounded by a timeout signal', async () => {
    let signal;
    fake.oembed = (_id, init) => { signal = init.signal; return { status: 200, body: { title: 't' } }; };
    await watch.load(V1, alice);
    assert.ok(signal instanceof AbortSignal);
  });

  test('titles are capped at 200 chars', async () => {
    fake.oembed = () => ({ status: 200, body: { title: 'x'.repeat(500) } });
    await watch.load(V1, alice);
    assert.equal(watch.get().title.length, 200);
  });
});

describe('controls', () => {
  test('play/pause/seek use the actor’s position, clamped to 0..24 h', async () => {
    await watch.load(V1, alice);
    assert.equal(watch.control('pause', 12.5, bob), true);
    assert.equal(watch.get().playing, false);
    assert.equal(watch.get().position, 12.5);
    watch.control('seek', 1e12, bob);
    assert.equal(watch.get().position, 86_400);
    watch.control('seek', -5, bob);
    assert.equal(watch.get().position, 0);
    watch.control('play', 30, bob);
    assert.equal(watch.get().playing, true);
    assert.equal(watch.get().action, 'play');
    assert.deepEqual(watch.get().by, bob);
  });

  test('a malformed position falls back to the server’s estimate', async () => {
    await watch.load(V1, alice);
    mock.timers.tick(7000);
    for (const junk of ['abc', null, undefined, {}, [], NaN, Infinity, '1e999']) {
      watch.control('seek', junk, bob);
      assert.ok(Math.abs(watch.get().position - 7) < 0.01, `junk ${String(junk)}`);
    }
  });

  test('unknown actions and controls with no video are ignored', async () => {
    assert.equal(watch.control('play', 0, bob), false);
    await watch.load(V1, alice);
    assert.equal(watch.control('rewind', 0, bob), false);
    assert.equal(updates.length, 1);
  });

  test('every change re-anchors the position, so queue edits never rewind anyone', async () => {
    await watch.load(V1, alice);
    mock.timers.tick(10_000);
    await watch.enqueue(V2, bob);
    const s = watch.get();
    assert.equal(s.action, 'enqueue');
    assert.ok(Math.abs(s.position - 10) < 0.01);
    assert.equal(s.updatedAt, Date.now());
    mock.timers.tick(5_000);
    watch.dequeue(s.queue[0].id, bob);
    assert.ok(Math.abs(watch.get().position - 15) < 0.01);
  });

  test('clear stops for everyone but keeps the queue', async () => {
    await watch.load(V1, alice);
    await watch.enqueue(V2, bob);
    watch.clear(bob);
    assert.equal(watch.get().videoId, null);
    assert.equal(watch.get().playing, false);
    assert.equal(watch.get().queue.length, 1);
  });
});

describe('queue', () => {
  test('enqueue starts immediately when nothing is on', async () => {
    await watch.enqueue(V1, alice);
    assert.equal(watch.get().videoId, V1);
    assert.equal(watch.get().queue.length, 0);
  });

  test('skip advances, dequeue removes by (string or number) id', async () => {
    await watch.load(V1, alice);
    await watch.enqueue(V2, alice);
    await watch.enqueue(V3, bob);
    const [, second] = watch.get().queue;
    assert.equal(watch.dequeue(String(second.id), alice), true);
    assert.equal(watch.dequeue(9999, alice), false);
    assert.equal(watch.skip(bob), true);
    assert.equal(watch.get().videoId, V2);
    assert.equal(watch.get().action, 'skip');
    assert.equal(watch.skip(bob), false, 'nothing left');
  });

  test('the queue is capped at 50', async () => {
    await watch.load(V1, alice);
    for (let i = 0; i < 50; i++) await watch.enqueue(V2, alice);
    await assert.rejects(watch.enqueue(V3, alice), (e) => e.expose && /full/.test(e.message));
  });

  test('concurrent enqueues cannot overshoot the cap', async () => {
    await watch.load(V1, alice);
    for (let i = 0; i < 49; i++) await watch.enqueue(V2, alice);
    const results = await Promise.allSettled([watch.enqueue(V3, alice), watch.enqueue(V3, bob), watch.enqueue(V3, bob)]);
    assert.equal(watch.get().queue.length, 50);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 2);
  });
});

describe('ending and the end timer', () => {
  async function playing(duration = 100) {
    await watch.load(V1, alice);
    await watch.enqueue(V2, bob);
    watch.reportDuration(V1, duration);
  }

  test('many clients reporting "ended" advance exactly once', async () => {
    await playing();
    mock.timers.tick(100_000);
    for (let i = 0; i < 5; i++) watch.ended(V1);
    assert.equal(watch.get().videoId, V2);
    assert.equal(watch.get().action, 'advance');
    assert.deepEqual(watch.get().by, bob, 'credited to whoever queued it');
    assert.equal(updates.filter((s) => s.action === 'advance').length, 1);
  });

  test('a stale "ended" for a previous video is ignored', async () => {
    await playing();
    watch.skip(alice);
    watch.ended(V1);
    assert.equal(watch.get().videoId, V2);
  });

  test('an early "ended" (client drifted or seeked alone) is ignored', async () => {
    await playing();
    mock.timers.tick(30_000);
    watch.ended(V1);
    assert.equal(watch.get().videoId, V1);
  });

  test('"ended" before any duration is known is trusted', async () => {
    await watch.load(V1, alice);
    await watch.enqueue(V2, bob);
    watch.ended(V1);
    assert.equal(watch.get().videoId, V2);
  });

  test('ending with an empty queue stops at the end', async () => {
    await watch.load(V1, alice);
    watch.reportDuration(V1, 50);
    mock.timers.tick(50_000);
    watch.ended(V1);
    const s = watch.get();
    assert.equal(s.playing, false);
    assert.equal(s.position, 50);
    assert.equal(s.action, 'ended');
    assert.equal(s.videoId, V1);
  });

  test('reportDuration validates input and only the first report counts', async () => {
    await watch.load(V1, alice);
    for (const bad of [NaN, -1, 0, 'x', 86_401, Infinity]) watch.reportDuration(V1, bad);
    watch.reportDuration(V2, 10); // other video
    assert.equal(watch.get().duration, null);
    watch.reportDuration(V1, '42.5');
    watch.reportDuration(V1, 99);
    assert.equal(watch.get().duration, 42.5);
  });

  test('the server advances on its own after duration + 1.5 s grace', async () => {
    await playing(20);
    await advance(mock.timers, 21_400, 200);
    assert.equal(watch.get().videoId, V1);
    await advance(mock.timers, 200, 100);
    assert.equal(watch.get().videoId, V2);
  });

  test('pausing disarms the timer; resuming re-arms it for the remaining time', async () => {
    await playing(20);
    mock.timers.tick(10_000);
    watch.control('pause', 10, alice);
    mock.timers.tick(60_000);
    assert.equal(watch.get().videoId, V1);
    watch.control('play', 10, alice);
    mock.timers.tick(11_000);
    assert.equal(watch.get().videoId, V1);
    mock.timers.tick(700);
    assert.equal(watch.get().videoId, V2);
  });

  test('seeking re-arms the timer', async () => {
    await playing(100);
    watch.control('seek', 95, alice);
    mock.timers.tick(6_600);
    assert.equal(watch.get().videoId, V2);
  });

  test('a seek past the end advances right away', async () => {
    await playing(100);
    watch.control('seek', 500, alice);
    mock.timers.tick(1);
    assert.equal(watch.get().videoId, V2);
  });

  test('the next video starts with no duration, so no timer until reported', async () => {
    await playing(10);
    mock.timers.tick(12_000);
    assert.equal(watch.get().videoId, V2);
    mock.timers.tick(3_600_000);
    assert.equal(watch.get().videoId, V2);
    assert.equal(watch.get().playing, true);
  });

  test('stop() leaves no timer behind', async () => {
    await playing(10);
    watch.stop();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(watch.get().videoId, V1);
  });
});
