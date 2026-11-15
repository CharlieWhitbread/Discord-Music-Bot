# Testing

```bash
npm test              # server: node:test, ~6 s, no network
npm run test:web      # web: Vitest + Testing Library + jsdom (cd web && npm test)
npm run test:all      # both
npm run test:live     # opt-in: one real call to YouTube oEmbed
```

Requires Node ≥ 22 (`node:test` mock timers with `Date`, glob arguments to
`--test`). Nothing touches real Discord, Spotify or YouTube except
`test:live`. Every test file runs in its own process with a fresh temp
`DATA_DIR` (deleted on exit) and a temp cwd, so a real `.env` is never read.

Tests marked **todo** reproduce known issues that need a design decision.
They run and report, but don't fail the suite.

## Server (`test/`)

| File | Covers |
|---|---|
| `mixer.test.js` | 3840-byte frames, silence, backpressure high/low marks, gain ramps, clip events, volume/mute, stall resync, `destroy()` |
| `sessionManager.test.js` | pipeline wiring, idempotent teardown on every failure path, EPIPE, slash commands |
| `storage.test.js` | `tags.js`, `db.js` (uniqueness, favourites, token expiry), `clipStore` LRU |
| `transcode.test.js` | ffprobe validation (incl. HLS SSRF), trim/loudnorm output format, serial queue |
| `spotify.test.js` | 401/429/5xx retry rules, device re-resolution, now-playing cache, OAuth state, scopes |
| `queue.test.js` | handover timing, reconcile, skip/play-now, drop rule, not-in-voice, interleaving |
| `playlists.test.js` | per-playlist lock, cache/TTL, duplicates, mid-failure, delete while playing |
| `watch.test.js` | re-anchoring, end timer, ended/duration reports, queue cap, oEmbed errors |
| `http.test.js` | real `server.start()`: routes, uploads (real ffmpeg), validation, errors, CORS, rate limits |
| `auth.test.js` | real auth: OAuth + guild gate, tokens, creator/admin permissions, CORS, WebSocket protocol |

### Fakes (`test/helpers/`)

- **`fakeSpotify.js`**: a stateful Spotify replacing `global.fetch`. It
  models the `uris`/`context_uri` context and index, the native queue, track
  end (native queue first, then the context, then stop: paused on the same
  item at progress 0), pause/resume/next/previous, shuffle (a flag only; order
  stays deterministic), playlists (paginated items, add, remove-all-copies,
  rename, unfollow via `DELETE /me/library`), devices, tokens (refresh, scope,
  rotation) and failure injection. Player commands answer **202/204 with a
  null body**, like Spotify. Time comes from `Date.now()`, so mock timers
  drive playback. It also stubs YouTube oEmbed, passes `localhost` through,
  and throws on any other host.
- **`fakeVoice.js`**: `@discordjs/voice` and `child_process.spawn` fakes,
  injected through the require cache before `sessionManager` loads. No
  production refactor was needed.
- **`audioFixtures.js`**: tiny audio and non-audio files generated with the
  bundled ffmpeg.
- **`server.js`**: boots the real server on a free port, plus a `ws` client
  helper.

## Web (`web/test/`)

These tests cover the utilities (`parseVideoId`, `recent`, `formatTag`),
`useSpotifySearch` (debounce and stale responses), and `ws.ts` (backoff and
the StrictMode remount race, using a fake `WebSocket` with async close). They
also cover `App` (tabs, hash routing, the YouTube tab staying mounted,
optimistic favourites), `SoundboardGrid`, `QueuePanel`, `AddToPlaylistMenu`
and the `PlaylistModal` create → edit flow.

`YouTubeTab` runs against a fake `window.YT.Player`. The tests cover:

- commands sent
- echo suppression
- ended and duration reports
- hard seek above 1.5 s vs rate nudge between 0.3 and 1.5 s
- the blocked-autoplay prompt
- the queue UI

## Not covered, and why

- **Real Discord voice, librespot and Opus encoding:** these need a bot
  token, a voice channel and a Premium account. `sessionManager` is tested
  against fakes, and the mixer's output format is asserted byte-exactly.
- **`src/index.js` and `deploy-commands.js`:** they log into Discord at
  require time. The command modules they load are tested directly.
- **The 100 MB upload cap:** it isn't configurable, and a 100 MB fixture is
  too slow. The 413 mapping for `LIMIT_FILE_SIZE` is in the error handler.
- **`UploadModal`, `EditClipModal`, `NowPlayingBar` and `audioExtract.ts`:**
  these depend on WaveSurfer, the Web Audio API and `MediaRecorder`, which
  jsdom doesn't implement.
- **End-to-end browser tests (Playwright):** these were optional and haven't
  been added.
- **Spotify's real end-of-context behaviour:** the fake's "paused on the last
  item at 0" is an assumption, so the queue's "track ended" heuristic is only
  as good as that model.
