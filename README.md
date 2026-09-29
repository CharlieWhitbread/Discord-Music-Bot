# Discord Spotify Connect Bot

A headless Spotify Connect receiver for a Raspberry Pi that pipes raw audio
from Spotify directly into a Discord voice channel.

## How it works

```
Spotify app ──(Spotify Connect)──▶ librespot ──(raw PCM s16le/44.1kHz)──▶ ffmpeg
                                                                            │
                                              (raw PCM s16le/48kHz, stereo) ▼
Discord voice channel ◀── AudioPlayer ◀── AudioResource (StreamType.Raw)
```

- `librespot` runs with `--backend pipe` and appears as a device in your
  Spotify Connect device list. Whatever you play to it is written to stdout
  as raw PCM (S16LE, 44 100 Hz, 2 channels).
- Discord requires 48 kHz audio, so a bundled `ffmpeg` (via `ffmpeg-static`)
  resamples the stream before it is handed to `@discordjs/voice`.

## Project structure

```
Discord-Music-Bot/
├── package.json
├── .env.example              # template — copy to .env
├── .gitignore
└── src/
    ├── index.js              # bot init, command routing, safety nets
    ├── config.js             # env loading & validation
    ├── deploy-commands.js    # slash command registration script
    ├── commands/
    │   ├── join.js           # /join — connect + spawn librespot
    │   ├── leave.js          # /leave — teardown
    │   ├── sound.js          # /sound — play a soundboard clip
    │   └── stopsound.js      # /stopsound — stop the current clip
    ├── audio/
    │   ├── sessionManager.js # librespot + ffmpeg + voice lifecycle
    │   └── mixer.js          # realtime frame clock; mutes Spotify under clips
    └── server/               # Express API + WebSocket (soundboard backend)
```

Plus `web/` — the React (Vite + TypeScript) soundboard frontend — and
`scripts/make-test-clip.js` for generating a test clip.

## Prerequisites

- Node.js ≥ 18 (LTS recommended)
- `librespot` installed on the Pi (e.g. `cargo install librespot` or a
  prebuilt binary). Verify with `librespot --version`.
- A Spotify **Premium** account (required by Spotify Connect).
- A Discord application with a bot user
  ([Developer Portal](https://discord.com/developers/applications)).

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure the environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:

   | Variable | Description |
   | --- | --- |
   | `DISCORD_TOKEN` | Bot token (Developer Portal → Bot → Token) |
   | `CLIENT_ID` | Application ID (General Information page) |
   | `GUILD_ID` | *(optional)* Guild for instant dev command registration |
   | `LIBRESPOT_PATH` | Path to the librespot binary (default `/usr/bin/librespot`) |
   | `LIBRESPOT_DEVICE_NAME` | Name shown in Spotify Connect (default `DiscordBot`) |
   | `LIBRESPOT_INITIAL_VOLUME` | 0–100 (default `100`) |

3. **Register the slash commands** (once, or after changing commands)

   ```bash
   npm run deploy
   ```

4. **Start the bot**

   ```bash
   npm start
   ```

## Usage

1. Join a voice channel in Discord.
2. Run `/join` — the bot connects and spawns librespot.
3. Open Spotify on any device, open the Connect device picker and select
   **DiscordBot** (or your configured name).
4. Play music. Audio is streamed into the voice channel.
5. Run `/leave` to disconnect and shut the receiver down.5. Run `/sound <name>` to play a soundboard clip (Spotify is muted while it
   plays), `/stopsound` to cut it off.

## Soundboard

A React web app (deployed to Azure Static Web Apps) lets friends upload,
trim, and trigger short audio clips in the voice channel. The bot hosts an
Express API + WebSocket on the Pi; clips are stored pre-transcoded as raw
PCM so a button press plays near-instantly. Spotify audio is muted (still
consumed, never paused) while a clip plays. See [PLAN.md](PLAN.md) for the
full design.

### Soundboard setup

1. **Discord OAuth2** — in the
   [Developer Portal](https://discord.com/developers/applications) →
   OAuth2: copy the *Client Secret* into `DISCORD_CLIENT_SECRET`, and add a
   redirect URI of `<PUBLIC_API_URL>/api/auth/callback`.
2. **Expose the Pi** — via Cloudflare Tunnel (needs a domain) or Tailscale
   Funnel (free `*.ts.net` hostname). The resulting HTTPS URL is
   `PUBLIC_API_URL`. Never port-forward.
3. **Azure Static Web App** (free tier) — create one, add the deployment
   token as the `AZURE_STATIC_WEB_APPS_API_TOKEN` GitHub secret and set a
   `VITE_API_BASE_URL` repository variable (= `PUBLIC_API_URL`). The
   workflow in `.github/workflows/deploy-web.yml` deploys `web/` on push.
   Set `WEB_ORIGIN` in `.env` to the SWA origin.
4. **Local dev** — set `AUTH_DISABLED=true` in `.env` (LAN only!), create
   `web/.env` with `VITE_API_BASE_URL=http://localhost:3000`, then
   `cd web && npm install && npm run dev`.
5. **Test clip** — `npm run test-clip` generates a 2 s chime named `test`;
   verify with `/join` then `/sound test`.
## Error handling & resilience

- **Child process failures** — `error`/`exit` events on both librespot and
  ffmpeg trigger a full, idempotent session teardown instead of crashing.
- **Stream errors** — `stdout`/`stdin` `error` events (including `EPIPE`
  during shutdown races) are caught and logged.
- **Voice disconnects** — channel moves and transient WebSocket closes get a
  bounded reconnect window; genuine kicks tear the session down.
- **Process-level nets** — `unhandledRejection` / `uncaughtException` are
  logged, and `SIGINT`/`SIGTERM` kill child processes and leave voice cleanly.

## Running as a service (optional)

Example `systemd` unit for the Pi (`/etc/systemd/system/discord-spotify.service`):

```ini
[Unit]
Description=Discord Spotify Connect Bot
After=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Discord-Music-Bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now discord-spotify
```
