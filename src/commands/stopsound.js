'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const sessionManager = require('../audio/sessionManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stopsound')
    .setDescription('Stop the currently playing soundboard clip')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const stopped = sessionManager.stopClip();
    if (!stopped) {
      await interaction.reply({
        content: 'No soundboard clip is playing.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply('Stopped the clip.');
  },
};
