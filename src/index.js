'use strict';

/**
 * Bot entry point: client setup, command loading and interaction routing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { generateDependencyReport } = require('@discordjs/voice');
const config = require('./config');
const sessionManager = require('./audio/sessionManager');

// Shows which opus/encryption/DAVE libraries @discordjs/voice detected.
console.log(generateDependencyReport());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // required for voice channel state
  ],
});

/* ─────────────────────── command loading ─────────────────────── */

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data?.name && typeof command.execute === 'function') {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`[loader] skipping ${file}: missing "data" or "execute"`);
  }
}

/* ─────────────────────── event handlers ─────────────────────── */

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[bot] error executing /${interaction.commandName}:`, err);
    const reply = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch { /* interaction expired — nothing to do */ }
  }
});

/* ─────────────────── process-level safety nets ─────────────────── */

// A dropped Spotify stream or dying child process must never kill the bot.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] uncaught exception:', err);
});

// Graceful shutdown: kill librespot/ffmpeg and leave voice cleanly.
function shutdown(signal) {
  console.log(`[process] received ${signal}, shutting down`);
  sessionManager.destroyAll();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ────────────────────────── start ────────────────────────── */

client.login(config.token).catch((err) => {
  console.error('[bot] failed to login:', err.message);
  process.exit(1);
});
