'use strict';

/**
 * Fakes for the bot's external edges: @discordjs/voice and child_process.
 * Both are injected before sessionManager is required (it destructures
 * them at load time), so no production refactor is needed.
 */

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');

const VoiceConnectionStatus = {
  Signalling: 'signalling', Connecting: 'connecting', Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed',
};

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.state = { status: VoiceConnectionStatus.Ready };
    this.subscribed = null;
    this.destroyCount = 0;
  }

  subscribe(player) {
    this.subscribed = player;
  }

  destroy() {
    this.destroyCount++;
    this.setStatus(VoiceConnectionStatus.Destroyed);
  }

  setStatus(status, extra = {}) {
    const old = this.state;
    this.state = { status, ...extra };
    this.emit('stateChange', old, this.state);
    this.emit(status, old, this.state);
  }
}

class FakePlayer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.resource = null;
    this.stopped = false;
  }

  play(resource) {
    this.resource = resource;
  }

  stop() {
    this.stopped = true;
  }
}

/** @returns fake voice module + the objects it created, for assertions */
function createFakeVoice() {
  const created = { connections: [], players: [], resources: [] };
  const voice = {
    created,
    /** Set to make the next entersState(Ready) reject (handshake timeout). */
    failReady: false,
    VoiceConnectionStatus,
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
    VoiceConnectionDisconnectReason: { WebSocketClose: 0 },
    NoSubscriberBehavior: { Play: 'play' },
    StreamType: { Raw: 'raw' },
    joinVoiceChannel(opts) {
      const c = new FakeConnection();
      c.joinOpts = opts;
      created.connections.push(c);
      return c;
    },
    async entersState(target, status) {
      if (status === VoiceConnectionStatus.Ready && voice.failReady) throw new Error('handshake timed out');
      if (target.state?.status === status) return target;
      // Like the real one: wait for the transition, give up after a timeout.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          target.off(status, onStatus);
          reject(new Error(`never entered ${status}`));
        }, 30);
        const onStatus = () => {
          clearTimeout(timer);
          resolve(target);
        };
        target.once(status, onStatus);
      });
    },
    createAudioPlayer(opts) {
      const p = new FakePlayer(opts);
      created.players.push(p);
      return p;
    },
    createAudioResource(stream, opts) {
      const r = { stream, opts };
      created.resources.push(r);
      return r;
    },
    generateDependencyReport: () => 'fake voice',
  };
  return voice;
}

class FakeChild extends EventEmitter {
  constructor(bin, args) {
    super();
    this.bin = bin;
    this.args = args;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.signals = [];
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    this.killed = true;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** Simulate the process exiting on its own (crash, end of stream). */
  exit(code, signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit('exit', code, signal);
  }
}

/**
 * Replace child_process.spawn. @returns {{children: FakeChild[], restore()}}
 */
function installFakeSpawn() {
  const original = childProcess.spawn;
  const children = [];
  childProcess.spawn = (bin, args) => {
    const child = new FakeChild(bin, args);
    children.push(child);
    return child;
  };
  return { children, restore: () => { childProcess.spawn = original; } };
}

/** Register a module in the require cache under another module's path. */
function injectModule(request, exports) {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

module.exports = { createFakeVoice, installFakeSpawn, injectModule, FakeChild, VoiceConnectionStatus };
