'use strict';

const { setupEnv, captureConsole, flush } = require('./helpers/env');

setupEnv({ LIBRESPOT_PATH: 'fake-librespot' });

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeVoice, installFakeSpawn, injectModule } = require('./helpers/fakeVoice');

const voice = createFakeVoice();
injectModule('@discordjs/voice', voice);
const spawner = installFakeSpawn();
const sessionManager = require('../src/audio/sessionManager');

const GUILD = 'guild-1';
const channel = (guildId = GUILD) => ({ id: 'vc-1', guild: { id: guildId, voiceAdapterCreator: () => ({}) }, toString: () => '#voice' });

let logs;
beforeEach((t) => {
  logs = captureConsole(t);
  spawner.children.length = 0;
  voice.created.connections.length = 0;
  voice.failReady = false;
});

afterEach(async () => {
  sessionManager.destroyAll();
  await flush(); // let the fake children's 'exit' events land while console is captured
});

async function join() {
  const result = await sessionManager.createSession(channel());
  const [librespot, ffmpeg] = spawner.children;
  const session = sessionManager.getActiveSession();
  return { result, librespot, ffmpeg, session, connection: voice.created.connections.at(-1) };
}

function assertTornDown({ librespot, ffmpeg, session, connection }) {
  assert.equal(sessionManager.hasSession(GUILD), false);
  assert.equal(session.destroyed, true);
  assert.ok(librespot.killed || librespot.exitCode !== null, 'librespot killed');
  assert.ok(ffmpeg.killed || ffmpeg.exitCode !== null, 'ffmpeg killed');
  assert.equal(session.mixer.destroyed, true, 'mixer destroyed');
  assert.equal(session.mixer._timer, null, 'mixer clock cleared');
  assert.equal(session.player.stopped, true, 'player stopped');
  assert.equal(connection.state.status, 'destroyed');
}

describe('createSession', () => {
  test('wires librespot → ffmpeg → mixer → player and reports status', async () => {
    const statuses = [];
    sessionManager.events.on('status', (s) => statuses.push(s));
    const { result, librespot, ffmpeg, session, connection } = await join();
    sessionManager.events.removeAllListeners('status');

    assert.deepEqual(result, { created: true });
    assert.equal(librespot.bin, 'fake-librespot');
    assert.ok(librespot.args.includes('pipe'), 'librespot uses the pipe backend');
    assert.ok(ffmpeg.args.includes('48000'), 'ffmpeg resamples to 48 kHz');
    assert.equal(connection.subscribed, session.player);
    // Invariant 2: the resource reads the mixer, never ffmpeg stdout.
    assert.equal(voice.created.resources.at(-1).stream, session.mixer);
    assert.equal(voice.created.resources.at(-1).opts.inputType, 'raw');
    assert.equal(statuses.at(-1).inVoice, true);
    assert.equal(sessionManager.getStatus().guildId, GUILD);
  });

  test('a second /join reuses the session', async () => {
    await join();
    const again = await sessionManager.createSession(channel());
    assert.deepEqual(again, { created: false });
    assert.equal(spawner.children.length, 2, 'no extra processes');
  });

  test('a voice handshake failure leaks nothing and rethrows', async () => {
    voice.failReady = true;
    await assert.rejects(sessionManager.createSession(channel()), /handshake/);
    assert.equal(sessionManager.hasSession(GUILD), false);
    assert.equal(spawner.children.length, 0, 'processes never spawned');
    assert.equal(voice.created.connections[0].state.status, 'destroyed');
  });
});

describe('teardown (invariant 3)', () => {
  test('destroySession kills both processes, the mixer, player and connection', async () => {
    const ctx = await join();
    assert.equal(sessionManager.destroySession(GUILD), true);
    assertTornDown(ctx);
    assert.deepEqual(ctx.librespot.signals, ['SIGTERM']);
  });

  test('is idempotent', async () => {
    const ctx = await join();
    assert.equal(sessionManager.destroySession(GUILD), true);
    assert.equal(sessionManager.destroySession(GUILD), false);
    await flush(); // child 'exit' events fire after the kill
    assert.equal(ctx.connection.destroyCount, 1);
    assert.equal(ctx.librespot.signals.length, 1);
    assert.equal(ctx.ffmpeg.signals.length, 1);
  });

  for (const [label, fail] of [
    ['librespot exits', (c) => c.librespot.exit(1)],
    ['ffmpeg exits', (c) => c.ffmpeg.exit(1)],
    ['librespot fails to spawn (ENOENT)', (c) => c.librespot.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))],
    ['ffmpeg emits error', (c) => c.ffmpeg.emit('error', new Error('boom'))],
    ['the voice connection is destroyed', (c) => c.connection.destroy()],
    ['Discord disconnects and the reconnect fails', (c) => c.connection.setStatus('disconnected', { reason: 1 })],
    ['Discord kicks the bot (4014)', (c) => c.connection.setStatus('disconnected', { reason: 0, closeCode: 4014 })],
  ]) {
    test(`tears down when ${label}`, async () => {
      const ctx = await join();
      fail(ctx);
      await new Promise((resolve) => setTimeout(resolve, 60)); // > fake entersState timeout
      assertTornDown(ctx);
    });
  }

  test('a voice reconnect in progress keeps the session alive', async () => {
    const ctx = await join();
    // Real @discordjs/voice moves to Connecting right after Disconnected.
    ctx.connection.prependOnceListener('disconnected', () => { ctx.connection.state = { status: 'connecting' }; });
    ctx.connection.setStatus('disconnected', { reason: 1 });
    await flush();
    assert.equal(sessionManager.hasSession(GUILD), true);
  });

  test('EPIPE on ffmpeg stdin during shutdown is swallowed (invariant 4)', async () => {
    const ctx = await join();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    ctx.ffmpeg.stdin.emit('error', epipe);
    ctx.ffmpeg.stdout.emit('error', new Error('stdout closed'));
    ctx.librespot.stdout.emit('error', new Error('stdout closed'));
    assert.ok(!logs.error.some((l) => l.includes('EPIPE')), 'EPIPE not even logged');
    assert.equal(sessionManager.hasSession(GUILD), true, 'stream errors alone do not tear down');
  });

  test('a player error does not crash or tear down', async () => {
    await join();
    voice.created.players.at(-1).emit('error', new Error('resource died'));
    assert.equal(sessionManager.hasSession(GUILD), true);
  });

  test('librespot PCM flows through ffmpeg into the mixer', async () => {
    const ctx = await join();
    ctx.ffmpeg.stdout.write(Buffer.alloc(3840, 1));
    await flush();
    assert.equal(ctx.session.mixer._spotifyBuffered, 3840);
  });
});

describe('soundboard API', () => {
  const clip = { id: 1, name: 'c', buffer: Buffer.alloc(3840 * 3) };

  test('playClip / stopClip need an active session', async () => {
    assert.equal(sessionManager.playClip(clip), false);
    assert.equal(sessionManager.stopClip(), false);
    assert.equal(sessionManager.setSpotifyMuted(true), false);
    await join();
    assert.equal(sessionManager.playClip(clip), true);
    assert.deepEqual(sessionManager.getStatus().clip, { id: 1, name: 'c' });
    assert.equal(sessionManager.stopClip(), true);
    assert.equal(sessionManager.getStatus().clip, null);
  });

  test('getStatus without a session', () => {
    assert.deepEqual(
      Object.keys(sessionManager.getStatus()).sort(),
      ['clip', 'inVoice', 'musicVolume', 'spotifyActive'],
    );
    assert.equal(sessionManager.getStatus().inVoice, false);
  });

  test('setMusicVolume clamps, rounds, rejects NaN and survives teardown', async () => {
    assert.equal(sessionManager.setMusicVolume(150), 100);
    assert.equal(sessionManager.setMusicVolume(-3), 0);
    assert.equal(sessionManager.setMusicVolume(42.6), 43);
    assert.equal(sessionManager.setMusicVolume('abc'), 43, 'NaN keeps the old value');
    assert.equal(sessionManager.setMusicVolume(Infinity), 100);
    sessionManager.setMusicVolume(40);
    const { session } = await join();
    assert.equal(session.mixer._volumeTarget, 0.4, 'new session picks up the saved volume');
  });
});

describe('slash commands', () => {
  function interaction(overrides = {}) {
    const replies = [];
    return {
      replies,
      guildId: GUILD,
      guild: { members: { me: {} } },
      member: { voice: { channel: { ...channel(), permissionsFor: () => ({ has: () => true }) } } },
      options: { getString: () => overrides.clipName },
      deferred: false,
      replied: false,
      reply: async (r) => { replies.push(r); },
      deferReply: async () => { replies.push('deferred'); },
      editReply: async (r) => { replies.push(r); },
      ...overrides,
    };
  }
  const isEphemeral = (r) => typeof r === 'object' && Boolean(r.flags);

  test('all command modules export data + execute', () => {
    for (const name of ['join', 'leave', 'sound', 'stopsound']) {
      const cmd = require(`../src/commands/${name}`);
      assert.equal(cmd.data.name, name);
      assert.equal(typeof cmd.execute, 'function');
    }
  });

  test('/join outside a voice channel replies ephemerally', async () => {
    const i = interaction({ member: { voice: {} } });
    await require('../src/commands/join').execute(i);
    assert.ok(isEphemeral(i.replies[0]));
  });

  test('/join without Connect/Speak permissions replies ephemerally', async () => {
    const i = interaction();
    i.member.voice.channel.permissionsFor = () => ({ has: () => false });
    await require('../src/commands/join').execute(i);
    assert.ok(isEphemeral(i.replies[0]));
    assert.equal(sessionManager.hasSession(GUILD), false);
  });

  test('/join then /leave', async () => {
    const i = interaction();
    await require('../src/commands/join').execute(i);
    assert.equal(i.replies[0], 'deferred');
    assert.match(i.replies[1], /Joined/);
    assert.equal(sessionManager.hasSession(GUILD), true);

    const again = interaction();
    await require('../src/commands/join').execute(again);
    assert.match(again.replies[1], /Already connected/);

    const leave = interaction();
    await require('../src/commands/leave').execute(leave);
    assert.match(leave.replies[0], /Disconnected/);
    const leaveAgain = interaction();
    await require('../src/commands/leave').execute(leaveAgain);
    assert.ok(isEphemeral(leaveAgain.replies[0]));
  });

  test('/join reports a failed session instead of throwing', async () => {
    voice.failReady = true;
    const i = interaction();
    await require('../src/commands/join').execute(i);
    assert.match(i.replies[1], /Failed to start/);
  });

  test('/sound and /stopsound', async () => {
    const db = require('../src/server/db');
    const clipStore = require('../src/server/clipStore');
    const fs = require('node:fs');
    const row = db.insertClip({ name: 'Airhorn', durationMs: 60, uploaderId: 'u', uploaderName: 'u', createdAt: Date.now() });
    fs.writeFileSync(clipStore.pcmPath(row.id), Buffer.alloc(3840 * 3));

    const sound = require('../src/commands/sound');
    const stopsound = require('../src/commands/stopsound');

    let i = interaction({ clipName: 'air' });
    await sound.execute(i);
    assert.ok(isEphemeral(i.replies[0]), 'not in voice → ephemeral');

    await join();
    i = interaction({ clipName: 'nope' });
    await sound.execute(i);
    assert.ok(isEphemeral(i.replies[0]), 'unknown clip → ephemeral');

    i = interaction({ clipName: 'air' }); // prefix match
    await sound.execute(i);
    assert.match(i.replies[0], /Playing \*\*Airhorn\*\*/);
    assert.equal(db.getClip(row.id).play_count, 1);

    i = interaction();
    await stopsound.execute(i);
    assert.equal(i.replies[0], 'Stopped the clip.');
    i = interaction();
    await stopsound.execute(i);
    assert.ok(isEphemeral(i.replies[0]));

    fs.unlinkSync(clipStore.pcmPath(row.id));
    clipStore.removeFiles(row.id);
    i = interaction({ clipName: 'Airhorn' });
    await sound.execute(i);
    assert.ok(isEphemeral(i.replies[0]), 'missing audio → ephemeral');
  });
});
