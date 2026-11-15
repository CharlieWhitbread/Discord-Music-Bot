'use strict';

/**
 * Test environment bootstrap. Must run before any src/ module is required:
 * config.js reads process.env (and .env) exactly once at load time.
 *
 * Each `node --test` file runs in its own process, so every file gets a
 * fresh temp DATA_DIR and its own module state.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const BASE_ENV = {
  DISCORD_TOKEN: 'test-token',
  CLIENT_ID: 'test-client',
  AUTH_DISABLED: 'true',
  SOUNDBOARD_ENABLED: 'true',
};

// Anything a developer's shell might export that would change behaviour.
const SCRUB = [
  'GUILD_ID', 'WEB_ORIGIN', 'PUBLIC_API_URL', 'DISCORD_CLIENT_SECRET', 'ADMIN_USER_IDS', 'ADMIN_USER',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SOUNDBOARD_PORT', 'LIBRESPOT_PATH',
  'LIBRESPOT_DEVICE_NAME', 'LIBRESPOT_CACHE_DIR', 'FFMPEG_PATH', 'FFPROBE_PATH',
];

/**
 * @param {Record<string, string>} [extra] env overrides
 * @param {{spotifyAuth?: object}} [opts] spotifyAuth is written to
 *   DATA_DIR/spotify-auth.json to simulate a linked account
 * @returns {string} the temp DATA_DIR
 */
function setupEnv(extra = {}, { spotifyAuth } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmb-test-'));
  for (const key of SCRUB) delete process.env[key];
  Object.assign(process.env, BASE_ENV, { DATA_DIR: dataDir }, extra);
  if (spotifyAuth) {
    fs.writeFileSync(path.join(dataDir, 'spotify-auth.json'), JSON.stringify(spotifyAuth));
  }

  // dotenv resolves .env from cwd; a temp cwd keeps a developer's real
  // .env (tokens!) out of the tests.
  const originalCwd = process.cwd();
  process.chdir(dataDir);

  process.on('exit', () => {
    process.chdir(originalCwd);
    // Close SQLite first or Windows refuses to delete the WAL files.
    const dbPath = path.join(SRC, 'server', 'db.js');
    try { require.cache[dbPath]?.exports.db.close(); } catch { /* not loaded */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dataDir;
}

/** Drop cached src/ modules so the next require gets fresh module state. */
function freshRequire(relPath, alsoReset = []) {
  for (const rel of [relPath, ...alsoReset]) {
    delete require.cache[require.resolve(path.join(SRC, rel))];
  }
  return require(path.join(SRC, relPath));
}

/** Let pending promise callbacks (fake fetch, async chains) run. */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Advance mocked timers in small steps, flushing async work between steps,
 * so chains of setTimeout → await fetch → setTimeout behave like real time.
 * @param {import('node:test').MockTimers} timers
 */
async function advance(timers, ms, step = 100) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    timers.tick(Math.min(step, ms - elapsed));
    await flush();
  }
}

/** Capture console output so expected warnings don't clutter test output. */
function captureConsole(t) {
  const logs = { log: [], warn: [], error: [] };
  for (const level of Object.keys(logs)) {
    t.mock.method(console, level, (...args) => { logs[level].push(args.join(' ')); });
  }
  return logs;
}

module.exports = { setupEnv, freshRequire, flush, advance, captureConsole, ROOT, SRC };
