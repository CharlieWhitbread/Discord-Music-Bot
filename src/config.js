'use strict';

/**
 * Centralised environment configuration.
 * Loads .env once and validates required values at startup so the
 * process fails fast with a clear message instead of a cryptic API error.
 */
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[config] Missing required environment variable: ${name}`);
    console.error('[config] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  return value.trim();
}

const config = {
  // Discord
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  guildId: process.env.GUILD_ID?.trim() || null,

  // librespot
  librespot: {
    path: process.env.LIBRESPOT_PATH?.trim() || '/usr/bin/librespot',
    deviceName: process.env.LIBRESPOT_DEVICE_NAME?.trim() || 'DiscordBot',
    initialVolume: Number.parseInt(process.env.LIBRESPOT_INITIAL_VOLUME ?? '100', 10) || 100,
  },

  // Audio format emitted by librespot's pipe backend.
  audio: {
    inputSampleRate: 44100, // librespot is fixed at 44.1 kHz
    outputSampleRate: 48000, // Discord requires 48 kHz
    channels: 2,
  },

  // Soundboard web server (Express + WebSocket, same process).
  server: {
    enabled: (process.env.SOUNDBOARD_ENABLED ?? 'true').toLowerCase() !== 'false',
    port: Number.parseInt(process.env.SOUNDBOARD_PORT ?? '3000', 10) || 3000,
    // Exact origin of the deployed web app, e.g. https://xyz.azurestaticapps.net
    // (CORS is pinned to this; localhost dev origins are always allowed).
    webOrigin: process.env.WEB_ORIGIN?.trim() || null,
    // Public HTTPS URL of this API through the tunnel, used to build the
    // OAuth redirect URI, e.g. https://api.example.com
    publicApiUrl: process.env.PUBLIC_API_URL?.trim() || null,
    // Discord OAuth2 client secret (Developer Portal → OAuth2).
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || null,
    // Set to 'true' to skip auth entirely (LAN development only!).
    authDisabled: (process.env.AUTH_DISABLED ?? 'false').toLowerCase() === 'true',
    // Comma-separated Discord user ids allowed to delete any clip.
    adminIds: (process.env.ADMIN_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Where clips + SQLite live.
    dataDir: process.env.DATA_DIR?.trim() || null,
    limits: {
      maxUploadBytes: 25 * 1024 * 1024,
      maxClipSeconds: 30,
    },
  },
};

module.exports = config;
