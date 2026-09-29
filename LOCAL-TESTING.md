# Local testing guide — Pi + desktop on the same LAN

Run the bot (and soundboard API) on the Raspberry Pi, and the React web app
on your desktop. No tunnel, no Azure, no OAuth — auth is disabled for this
mode, so **only use it on your home network**.

```
Desktop browser (localhost:5173) ──HTTP/WS──▶ Pi (:3000)  ──▶ Discord voice
        ▲                                      ▲
   Vite dev server                        node src/index.js
```

---

## Part 1 — Raspberry Pi (bot + API)

### 1. Prerequisites

```bash
node -v          # must be ≥ 18
librespot --version
```

If `better-sqlite3` has no prebuilt binary for your Pi (32-bit OS), the
install step compiles it — make sure build tools exist:

```bash
sudo apt install -y build-essential python3
```

### 2. Get the latest code

```bash
cd ~/Discord-Music-Bot        # or wherever you cloned it
git pull origin main
npm install
```

First time on this Pi instead:

```bash
git clone https://github.com/CharlieWhitbread/Discord-Music-Bot.git
cd Discord-Music-Bot
npm install
```

### 3. Configure `.env`

```bash
cp .env.example .env   # if you don't already have one
nano .env
```

Required for LAN testing:

```ini
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-guild-id
LIBRESPOT_PATH=/usr/bin/librespot   # adjust to `which librespot`

SOUNDBOARD_ENABLED=true
SOUNDBOARD_PORT=3000
AUTH_DISABLED=true                  # LAN ONLY — never with a tunnel up
```

Leave `WEB_ORIGIN`, `PUBLIC_API_URL` and `DISCORD_CLIENT_SECRET` empty —
they're only needed for the public OAuth deployment later.

### 4. Register the new slash commands (once)

```bash
npm run deploy
```

This adds `/sound` and `/stopsound` alongside `/join` and `/leave`.

### 5. Generate the test clip (once)

```bash
npm run test-clip
```

Creates a 2 s chime named `test` in `data/`.

### 6. Find the Pi's LAN IP and start the bot

```bash
hostname -I     # e.g. 192.168.1.42 — you need this for the desktop
npm start
```

You should see:

```
[server] soundboard API listening on :3000 (AUTH DISABLED — LAN dev only!)
Logged in as <bot name>
```

> If another machine can't reach port 3000, check for a firewall on the Pi
> (`sudo ufw status` — allow with `sudo ufw allow 3000/tcp`).

---

## Part 2 — Desktop (web app)

### 1. Get the code and install

```powershell
cd Discord-Music-Bot
git pull origin main
cd web
npm install
```

### 2. Point the web app at the Pi

Create `web/.env` (or copy `web/.env.example`):

```ini
VITE_API_BASE_URL=http://192.168.1.42:3000
```

Use the IP from `hostname -I` on the Pi. No trailing slash.

### 3. Run the dev server

```powershell
npm run dev
```

Open **http://localhost:5173** — it must be `localhost`, not your desktop's
LAN IP, because the Pi's CORS allow-list only includes
`http://localhost:5173` and `http://127.0.0.1:5173` for dev.

With `AUTH_DISABLED=true` on the Pi you land straight on the soundboard —
no Discord login.

---

## Part 3 — Test flow

1. Join a voice channel in Discord and run `/join`.
2. The web app banner should switch from "run /join" to ready, and the
   **test** tile becomes clickable.
3. Press the tile → the chime plays in the voice channel (also works via
   `/sound test` in Discord).
4. Start Spotify playback on the bot (Connect device picker), then press
   the tile again → music fades to silence under the clip and fades back
   in after — the track keeps advancing, by design.
5. Upload a clip: **+ Add clip** → pick a file (≤ 25 MB) → drag the trim
   region (≤ 30 s) → preview → upload. The new tile appears for everyone.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Bot unreachable" banner | Pi not running / wrong IP in `web/.env` / port 3000 blocked. Try `http://<pi-ip>:3000/api/health` in the browser. |
| Login screen appears | `AUTH_DISABLED` is not `true` on the Pi, or the API is unreachable. |
| CORS error in console | You opened the app via a LAN IP — use `http://localhost:5173`. |
| Tiles greyed out | Bot isn't in a voice channel — run `/join`. |
| `/sound` says unknown command | Run `npm run deploy` on the Pi, wait a minute, restart the Discord client. |
| `better-sqlite3` install fails on Pi | `sudo apt install -y build-essential python3` then `npm install` again. |

When you're done testing, either stop the bot or set `AUTH_DISABLED=false`
before ever exposing the Pi beyond your LAN.
