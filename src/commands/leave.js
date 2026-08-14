'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const sessionManager = require('../audio/sessionManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect from voice and shut down the Spotify Connect receiver')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const destroyed = sessionManager.destroySession(interaction.guildId);

    if (!destroyed) {
      await interaction.reply({
        content: 'I am not connected to a voice channel in this server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply('Disconnected and stopped the Spotify Connect receiver.');
  },
};
