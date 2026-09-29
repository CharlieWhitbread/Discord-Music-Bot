# Soundboard Feature — Implementation Plan

Web-based soundboard for the Discord Spotify Connect bot: friends upload and
trim audio clips in a React app, then trigger them in the voice channel with
near-instant latency. Spotify audio is **muted** (not paused) while a clip
plays.

## 1. Architecture overview

```
                 ┌────────────────────────────────────────┐
                 │ Azure Static Web App (free tier)       │
Browser ──HTTPS─▶│ React bundle only — no compute         │
                 └────────────────────────────────────────┘
                              │
        HTTPS (uploads, clip list, auth)      WebSocket (play commands, status)
                              │                       │
                              ▼                       ▼
                 ┌────────────────────────────────────────┐
                 │ Cloudflare Tunnel / Tailscale Funnel   │  ← outbound from Pi,
                 └────────────────────────────────────────┘    no open ports
                              │
                              ▼
                 ┌────────────────────────────────────────┐
                 │ Raspberry Pi — single Node process     │
                 │  • Express API + WebSocket server      │
                 │  • Discord bot (existing)              │
                 │  • librespot + ffmpeg pipeline         │
                 │  • PCM mixer (new)                     │
                 │  • SQLite metadata + clip files on disk│
                 └────────────────────────────────────────┘
```

Key decisions (settled during design discussion):

| Decision | Choice | Rationale |
| --- | --- | --- |
| Clip vs Spotify | **Mute Spotify while clip plays** | Simpler + more robust than backpressure-pause; pipeline pacing untouched; track keeps advancing (acceptable — like someone talking over music) |
| Guilds | **Single guild** | Friends-only bot; no guild picker; API operates on "the" session |
| Frontend hosting | **Azure Static Web App (free)** | Static files only; every API call goes browser → Pi directly |
| Azure Functions | **Rejected** | Doesn't make the Pi reachable; consumption cold starts (1–5 s) kill soundboard latency |
| Pi exposure | **Cloudflare Tunnel** (if a domain is owned) or **Tailscale Funnel** (no domain needed) | Outbound-only, free HTTPS, no port forwarding; SWA is HTTPS-only so the Pi endpoint must be HTTPS (mixed content) |
| Play command transport | **Persistent WebSocket** | One hot round trip (~30–80 ms) vs 150–300 ms per-press HTTPS handshake; also carries live status. HTTP POST fallback during reconnects |
| Auth | **Discord OAuth2, bearer tokens** | Guild-membership gate; bearer over cookies because SWA↔Pi is cross-site (third-party cookie blocking) |
| Clip storage format | **Pre-transcoded raw s16le / 48 kHz / stereo PCM** at upload time (+ small OGG copy for browser preview) | Zero decode at play time; open file/read from cache and go |
| Trimming | **UI client-side (WaveSurfer.js), actual cut server-side (ffmpeg `-ss`/`-to`)** | Canonical output, no trust in client encoding |

### Latency budget (press → heard in Discord)

| Segment | Cost | Notes |
| --- | --- | --- |
| Browser → Pi over open WebSocket | 30–80 ms | The optimizable lever; avoid per-press TLS handshakes |
| Pi clip start | ~0–20 ms | Pre-transcoded PCM, mixer flips on next 20 ms frame; cache hot clips in RAM (10 s clip ≈ 1.9 MB) |
| Discord voice path (Opus encode, relay, client jitter buffer) | 150–400 ms | Fixed, not optimizable |
| **Total** | **~250–500 ms** | Same ballpark as Discord's native soundboard |

The existing pipeline already keeps the AudioPlayer permanently non-idle
(silence padding), so the Opus encoder and voice connection are always warm.

## 2. The mixer (core audio change)

`src/audio/mixer.js` — replaces the current `PassThrough` + silence-timer in
`sessionManager`. Not true N-way mixing; it is a **frame-based switcher**:

- Emits one 3840-byte frame (20 ms of s16le/48kHz/stereo) per tick.
- **Always consumes Spotify PCM at realtime rate** — critical: librespot's
  pipe backend has no clock and relies on consumer backpressure for pacing.
  The Spotify pipeline must never notice a clip is playing.
- State `SPOTIFY`: pass Spotify frames through; inject silence frames when no
  PCM arrives within 200 ms (absorbs existing silence-timer logic).
- State `CLIP`: output clip PCM frames; Spotify frames are read and
  **discarded** (mute). Optional configurable duck level later (0% = mute,
  30% = quiet background — same multiply, different constant).
- Transitions: instant, with an optional ~50 ms fade ramp to avoid clicks.
- Second button press while a clip plays: **replace** current clip (snappier
  than queueing).
- API: `playClip(pcmBufferOrPath)`, `stopClip()`, state events for status
  reporting.

`sessionManager` changes: `session.output` becomes the mixer; expose
`playClip(clipId)` / `stopClips()` / `getStatus()`; everything else
(teardown, reconnect logic, process wiring) stays as-is.

## 3. Backend (`src/server/`)

Runs inside the existing Node process (imports `sessionManager` directly).

| Piece | Details |
| --- | --- |
| `server.js` | Express + `helmet` + CORS pinned to the exact SWA origin (credentials mode — no `*`); started from `src/index.js` |
| `ws.js` | WebSocket server (`ws` package): authenticated on connect (token), receives `{play, clipId}` / `{stop}`, broadcasts status (now playing, bot-in-voice) |
| `auth.js` | Discord OAuth2 (`identify` + `guilds`); guild-membership check against the bot's guild; issues bearer token; OAuth callback lands on the Pi API domain then redirects to the SWA URL with a one-time exchange code |
| `routes/clips.js` | `GET /api/clips` · `POST /api/clips` (multer, ≤ 25 MB, ≤ 30 s post-trim, mime + ffprobe validation, trim params `{start,end}`) · `DELETE /api/clips/:id` (uploader or admin) · `GET /api/clips/:id/audio` (OGG preview) |
| `routes/play.js` | `POST /api/play/:clipId` (HTTP fallback) · `POST /api/stop` · `GET /api/status` |
| `db.js` | `better-sqlite3`; `clips` table: id, name, emoji/color, uploader (Discord id + name), duration, play_count, created_at |
| `transcode.js` | ffmpeg wrapper: trim → `loudnorm` → `.pcm` (48 kHz s16le stereo) + `.ogg` preview; uploads processed serially (Pi CPU) |
| Limits | `express-rate-limit` on upload; storage cap (e.g. 200 clips / 500 MB) with admin delete |

## 4. Frontend (`web/`)

React + Vite + TypeScript, deployed to Azure Static Web Apps via the free
GitHub Actions pipeline. `VITE_API_BASE_URL` + WS URL baked at build from a
repo secret.

1. **Login** — "Sign in with Discord"; token kept in memory/localStorage,
   sent via `Authorization` header and on WS connect.
2. **Soundboard grid** — responsive tiles (name, emoji/color, duration,
   uploader); press → WS message; live "now playing" highlight from WS
   broadcasts; stop-all button.
3. **Upload flow** — drag & drop → WaveSurfer.js waveform → drag-handle trim
   region + local preview → name/emoji → upload with progress.
4. **Status banner** — bot offline / not in voice (tiles disabled with a
   "run /join" hint); WS reconnect with backoff; graceful "Pi unreachable"
   state rather than failed-fetch noise.

## 5. Milestones

1. **Mixer refactor** — `mixer.js` switcher + `playClip()` in
   `sessionManager`, tested via a temporary `/sound` slash command with a
   hardcoded PCM file. De-risks the audio work first.
2. **API server** — Express skeleton, SQLite, upload → transcode → play
   endpoints. LAN only, no auth yet.
3. **React app** — grid + upload + trim against the LAN API; WebSocket play
   path as the primary channel.
4. **Auth + hardening** — Discord OAuth, guild gating, rate limits,
   validation, size/duration caps, CORS pinned.
5. **Public exposure** — Cloudflare Tunnel or Tailscale Funnel on the Pi,
   SWA deployment via GitHub Actions, systemd unit update, README docs.

## 6. Risks & notes

- **Pi CPU**: mixing is trivial; upload transcodes spike CPU — queue them
  serially.
- **Muted ≠ paused**: the track advances under the clip; a 10 s clip skips
  10 s of song. Accepted trade-off.
- **Tunnel down / Pi off**: SWA page still loads; frontend must show an
  offline banner.
- **Security**: the tunnel makes the API publicly reachable — auth on every
  route and on WS connect is doing all the real work. Never trust client
  audio: validate with ffprobe, re-encode server-side.
- **Upload size via tunnel**: Cloudflare caps requests at 100 MB — fine for
  the 25 MB clip limit.
