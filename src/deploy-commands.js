'use strict';

/**
 * One-shot script to register slash commands with Discord.
 * Run with: npm run deploy
 *
 * If GUILD_ID is set, commands register instantly to that guild (ideal for
 * development). Otherwise they register globally (may take up to an hour).
 */
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commands = [];
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(config.token);

(async () => {
  try {
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);

    console.log(`[deploy] registering ${commands.length} command(s) ${config.guildId ? `to guild ${config.guildId}` : 'globally'}...`);
    const data = await rest.put(route, { body: commands });
    console.log(`[deploy] successfully registered ${data.length} command(s).`);
  } catch (err) {
    console.error('[deploy] failed to register commands:', err);
    process.exit(1);
  }
})();
