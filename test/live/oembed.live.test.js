'use strict';

/**
 * Opt-in live check of the one external call watch.js makes (YouTube
 * oEmbed). Not part of `npm test`; run with `npm run test:live`.
 */

const { setupEnv, freshRequire } = require('../helpers/env');

setupEnv();

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('oEmbed: a public video loads with its title; a missing one is rejected', async () => {
  const watch = freshRequire('server/watch.js');
  await watch.load('dQw4w9WgXcQ', { userId: 'live', username: 'live' });
  assert.match(watch.get().title ?? '', /Rick Astley/i);
  await assert.rejects(watch.load('xxxxxxxxxxx', { userId: 'live', username: 'live' }), /not found|embedded/);
  watch.stop();
});
