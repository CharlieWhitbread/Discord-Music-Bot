'use strict';

/**
 * Opt-in live check against the real Spotify Web API and the bot's real
 * librespot speaker (`npm run test:spotify-live`). Plays music on the
 * account — the bot must be in a voice channel. Leaves playback paused.
 *
 * Uses the bot's own src/server/spotify.js and a Spotify token from
 * DATA_DIR/spotify-auth.json. Point DATA_DIR at a copy made with a separate
 * login rather than the Pi's own file: a refresh here may rotate the token.
 *
 * Measures:
 *  - lead: how far librespot runs ahead of what Discord plays. librespot
 *    reports the position it has *written*; the jump in that position at a
 *    pause, beyond the wall-clock play time, is the audio still buffered
 *    downstream. It's what keeps playing after a pause. Want < 1.5 s.
 *  - stale reads: no published state may contradict a pause/resume.
 *
 * Usage: node scripts/spotify-live-check.js [contextUri] [rounds]
 */

const spotify = require('../src/server/spotify');
const config = require('../src/config');

const CONTEXT = process.argv[2] || process.env.SPOTIFY_LIVE_CONTEXT;
const ROUNDS = Number(process.argv[3] || 3);
const PLAY_MS = 6000;
const MAX_LEAD_S = 1.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the reported position stops changing (paused and settled). */
async function settledPausedPosition() {
  let last = null;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const np = await spotify.fetchNowPlaying();
    if (np?.active && !np.isPlaying) {
      if (last !== null && Math.abs(np.progressMs - last) < 50 && i >= 6) return np.progressMs;
      last = np.progressMs;
    }
  }
  return last;
}

async function main() {
  if (!spotify.connected()) throw new Error('Spotify not connected: no spotify-auth.json in DATA_DIR');
  if (!CONTEXT) throw new Error('Pass a playlist/album URI: node scripts/spotify-live-check.js spotify:playlist:…');

  const published = [];
  spotify.events.on('nowplaying', (np) => published.push({ at: Date.now(), playing: np.active && np.isPlaying }));

  console.log(`Device "${config.librespot.deviceName}", context ${CONTEXT}`);
  await spotify.playContext(CONTEXT, 0);
  await spotify.setShuffle(false);
  await sleep(4000);
  await spotify.pause();
  let pos = await settledPausedPosition();

  const leads = [];
  const staleViolations = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const resumedAt = Date.now();
    await spotify.resume();
    await sleep(PLAY_MS);
    const pausedAt = Date.now();
    await spotify.pause();
    const after = await settledPausedPosition();
    const wallS = (pausedAt - resumedAt) / 1000;
    const advancedS = (after - pos) / 1000;
    const lead = advancedS - wallS;
    leads.push(lead);
    console.log(`round ${round}: played ${wallS.toFixed(2)} s by the clock, position advanced ${advancedS.toFixed(2)} s → lead ${lead.toFixed(2)} s`);

    // Anything published after the pause command must say "paused".
    const bad = published.filter((p) => p.at > pausedAt + 50 && p.playing);
    if (bad.length) staleViolations.push(`round ${round}: published "playing" after pause`);
    pos = after;
  }

  const worst = Math.max(...leads);
  console.log(`\nworst lead ${worst.toFixed(2)} s (want < ${MAX_LEAD_S} s)`);
  for (const v of staleViolations) console.log(`stale state published: ${v}`);
  const ok = worst < MAX_LEAD_S && staleViolations.length === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`ERROR ${err.message}`);
  await spotify.pause().catch(() => {});
  process.exit(2);
});
