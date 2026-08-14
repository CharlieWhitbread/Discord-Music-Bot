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
    │   └── leave.js          # /leave — teardown
    └── audio/
        └── sessionManager.js # librespot + ffmpeg + voice lifecycle
```

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
5. Run `/leave` to disconnect and shut the receiver down.

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
