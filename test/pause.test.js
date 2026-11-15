'use strict';

const { setupEnv, captureConsole, flush } = require('./helpers/env');
const { FakeSpotify, FULL_SCOPE } = require('./helpers/fakeSpotify');

setupEnv({
  LIBRESPOT_PATH: 'fake-librespot',
  SPOTIFY_CLIENT_ID: 'sp-client',
  SPOTIFY_CLIENT_SECRET: 'sp-secret',
  PUBLIC_API_URL: 'https://api.test',
}, { spotifyAuth: { refreshToken: 'refresh-0', scope: FULL_SCOPE } });

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeVoice, installFakeSpawn, injectModule } = require('./helpers/fakeVoice');

injectModule('@discordjs/voice', createFakeVoice());
installFakeSpawn();
const sessionManager = require('../src/audio/sessionManager');
const spotify = require('../src/server/spotify');
const { pausePlayback, resumePlayback } = require('../src/server/routes/spotify');

const channel = { id: 'vc', guild: { id: 'g', voiceAdapterCreator: () => ({}) } };
let fake;
let mixer;

beforeEach(async (t) => {
  captureConsole(t);
  fake = new FakeSpotify().install();
  fake.addTracks(3);
  await sessionManager.createSession(channel);
  mixer = sessionManager.getActiveSession().mixer;
  await spotify.playUris([fake.catalog.values().next().value.uri]);
});

afterEach(async () => {
  sessionManager.destroyAll();
  fake.uninstall();
  await flush();
});

const np = (over) => ({ active: true, isPlaying: true, requestedAt: Date.now(), track: { uri: 'x' }, ...over });

describe('pause from the website', () => {
  test('mutes until librespot is quiet instead of for a fixed time', async () => {
    await pausePlayback();
    assert.equal(mixer._quietMuteSince !== null, true, 'quiet-mute mode');
    assert.equal(mixer.getState().musicMuted, true);
    assert.equal(fake.state().isPlaying, false, 'real pause sent');
  });

  test('a failed pause unmutes straight away', async () => {
    fake.fail('PUT', '/me/player/pause', 502, { times: 2 });
    await assert.rejects(pausePlayback());
    assert.equal(mixer.getState().musicMuted, false);
  });

  test('resume unmutes immediately', async () => {
    await pausePlayback();
    await resumePlayback();
    assert.equal(mixer.getState().musicMuted, false);
    assert.equal(mixer._quietMuteSince, null);
  });

  test('a fresh "playing" read (resumed from the Spotify app) unmutes; a stale one does not', async () => {
    await pausePlayback();
    const pausedAt = Date.now();
    spotify.events.emit('nowplaying', np({ requestedAt: pausedAt + 300 })); // inside the stale window
    assert.equal(mixer.getState().musicMuted, true);
    spotify.events.emit('nowplaying', np({ requestedAt: pausedAt + 2000 }));
    assert.equal(mixer.getState().musicMuted, false);
  });
});
