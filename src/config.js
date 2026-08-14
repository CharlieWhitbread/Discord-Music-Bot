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
};

module.exports = config;
