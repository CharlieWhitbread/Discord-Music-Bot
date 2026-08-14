'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const sessionManager = require('../audio/sessionManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and start the Spotify Connect receiver')
    .setDMPermission(false),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: 'You must be in a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Verify the bot can actually connect and speak there.
    const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!permissions?.has(['Connect', 'Speak'])) {
      await interaction.reply({
        content: `I need **Connect** and **Speak** permissions in ${voiceChannel}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Joining + spawning processes can take a few seconds.
    await interaction.deferReply();

    try {
      const { created } = await sessionManager.createSession(voiceChannel);

      if (!created) {
        await interaction.editReply('Already connected — look for the device in your Spotify Connect list.');
        return;
      }

      await interaction.editReply(
        `Joined ${voiceChannel}. Open Spotify and select the Connect device to start streaming.`,
      );
    } catch (err) {
      console.error('[command:join] failed to create session:', err);
      await interaction.editReply(
        'Failed to start the audio session. Check that librespot is installed and the bot logs for details.',
      );
    }
  },
};
