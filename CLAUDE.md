# CLAUDE.md

Guidance for AI coding agents working in this repository.

## What this project is

A headless **Spotify Connect receiver** running on a Raspberry Pi that pipes
audio into a **Discord voice channel**, plus (in progress) a **web soundboard**:
a React app on Azure Static Web Apps where friends upload/trim clips and
trigger them in the voice channel. See [PLAN.md](PLAN.md) for the full
soundboard design and milestones.

## Commands

```bash
npm install          # install deps
npm start            # run the bot (node src/index.js)
npm run deploy       # register slash commands (once, or after changing them)
```

No test suite or linter is configured. Node ≥ 18, CommonJS (`'use strict'`,
`require`), plain JavaScript — no TypeScript in `src/`. The planned React app
in `web/` will be Vite + TypeScript.

Runtime target is a **Raspberry Pi** (also runs on Windows/dev machines, but
librespot must be installed separately; ffmpeg comes from `ffmpeg-static`).

## Architecture

### Audio pipeline (the heart of everything)

```
Spotify app ──Connect──▶ librespot (--backend pipe, s16le/44.1kHz stdout)
                             │
                             ▼
                          ffmpeg (resample → s16le/48kHz stereo)
                             │
                             ▼
                    Mixer (src/audio/mixer.js)  ◀── soundboard clip PCM
                             │
                             ▼
        AudioResource (StreamType.Raw) → AudioPlayer → VoiceConnection
```

The Mixer is the single realtime pacer: a drift-compensated 20 ms clock
emits exactly one 3840-byte frame per tick. Its `spotifyInput` Writable
parks the write callback when >240 ms is buffered — that backpressure is
what paces librespot. While a clip plays, Spotify PCM keeps being consumed
but is gain-ramped to silence (60 ms fade), then blended back in.

### Files

- `src/index.js` — client setup, command loading from `src/commands/`,
  interaction routing, process-level safety nets (unhandledRejection,
  SIGINT/SIGTERM teardown).
- `src/config.js` — env loading/validation (dotenv). All config comes from
  `.env`; never hardcode tokens or paths.
- `src/audio/sessionManager.js` — owns the full per-guild session: librespot
  + ffmpeg child processes, voice connection, player. `sessions` map keyed by
  guildId (in practice a single guild is used).
- `src/commands/*.js` — slash commands exporting `{ data, execute }`;
  auto-loaded by filename.
- `src/deploy-commands.js` — registers slash commands (guild-scoped when
  `GUILD_ID` is set, else global).

### Soundboard components (design details in PLAN.md)

- `src/audio/mixer.js` — frame-based mixer (see diagram above): realtime
  clock, Spotify backpressure pacing, clip blend with gain ramp. Exposes
  `playClip`/`stopClip`/`getState`, emits `clipstart`/`clipend`.
- `src/commands/sound.js` / `stopsound.js` — `/sound <name>`, `/stopsound`.
- `src/server/` — Express API + WebSocket in the same process (imports
  sessionManager directly): `db.js` (better-sqlite3), `clipStore.js` (PCM
  LRU cache), `transcode.js` (serial ffmpeg queue: trim + loudnorm → PCM +
  OGG preview), `auth.js` (Discord OAuth2 → bearer tokens, guild gate),
  `routes/clips.js`, `routes/play.js`, `ws.js` (primary play channel),
  `server.js` (CORS pinned to WEB_ORIGIN, helmet, rate limits).
- `web/` — React soundboard (Vite + TS): login, tile grid, upload modal
  with WaveSurfer trim, WebSocket with HTTP fallback. Deployed to Azure
  Static Web Apps via `.github/workflows/deploy-web.yml`.
- `scripts/make-test-clip.js` (`npm run test-clip`) — generates a 2 s chime
  clip named `test` for end-to-end verification.
- Clips stored as pre-transcoded **raw s16le/48 kHz/stereo PCM** (+ OGG
  preview) under `data/clips/`, metadata in SQLite (`data/soundboard.db`).

## Critical invariants — do not break these

1. **librespot's pipe backend has no clock.** It paces itself on consumer
   backpressure. The consumer must read PCM at realtime rate *continuously* —
   even while a soundboard clip plays (read & discard, never stop reading,
   never unpipe). Stopping reads stalls Spotify playback.
2. **The AudioPlayer must never go idle.** When Spotify pauses, librespot
   stops writing; silence frames are injected (200 ms threshold) so
   @discordjs/voice never destroys the stream. The resource must NOT read
   ffmpeg stdout directly.
3. **Teardown must be complete and idempotent.** Every child process, timer,
   stream and connection lives on the `Session` object; `destroySession` is
   guarded by `session.destroyed`. Any new resource (WS server, file
   handles, mixer timers) must be added to teardown.
4. **EPIPE during shutdown races is expected** — swallow it on
   ffmpeg.stdin/stdout error handlers; the process exit handlers do cleanup.
5. **Discord requires 48 kHz stereo s16le** for `StreamType.Raw`. One frame =
   20 ms = 3840 bytes. All soundboard PCM must match exactly.
6. **Errors must never kill the bot.** Child process failures tear down the
   session, not the process. Follow the existing pattern: log with a
   `[component:guildId]` prefix, degrade gracefully.

## Design decisions already made (do not relitigate)

- Clip playback **mutes** Spotify (discard samples); no pause, no true mixing.
  Track keeps advancing under the clip — accepted.
- Single guild; friends-only audience.
- Frontend on **Azure Static Web App free tier** (static only — no Azure
  Functions; cold starts were rejected for latency).
- Pi exposed via **Cloudflare Tunnel or Tailscale Funnel** — never port
  forwarding. Browser talks straight to the Pi API through the tunnel.
- Play commands travel over a **persistent WebSocket** (latency: one hot
  round trip); HTTP POST is only a fallback. Target press-to-sound is
  ~250–500 ms, dominated by Discord's fixed voice path.
- Auth: **Discord OAuth2 + bearer tokens** (not cookies — SWA↔Pi is
  cross-site), guild-membership gate, CORS pinned to the exact SWA origin.
- Trim UX client-side (WaveSurfer.js); authoritative cut + `loudnorm` +
  transcode server-side with ffmpeg. Validate uploads with ffprobe; caps:
  25 MB file, 30 s post-trim.

## Conventions

- Match the existing style: `'use strict'`, CommonJS, single quotes,
  2-space indent, JSDoc typedefs for structured objects, section-divider
  comments (`/* ─── ... ─── */`).
- Comments explain *why* (backpressure, race conditions), not *what*.
- Slash command replies that indicate errors are ephemeral
  (`MessageFlags.Ephemeral`).
- Secrets/config only via `.env` (`.env.example` documents the variables).
