'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const sessionManager = require('../audio/sessionManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sound')
    .setDescription('Play a soundboard clip (mutes Spotify while it plays)')
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Clip name (exact or prefix)').setRequired(true),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Lazy require: keeps the bot bootable if server deps aren't installed.
    const db = require('../server/db');
    const clipStore = require('../server/clipStore');

    const name = interaction.options.getString('name', true);
    const clip = db.findClipByName(name);
    if (!clip) {
      await interaction.reply({
        content: `No clip named **${name}** found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const buffer = clipStore.loadPcm(clip.id);
    if (!buffer) {
      await interaction.reply({
        content: 'That clip\'s audio file is missing on disk.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const started = sessionManager.playClip({ id: clip.id, name: clip.name, buffer });
    if (!started) {
      await interaction.reply({
        content: 'I am not in a voice channel — run `/join` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    db.bumpPlayCount(clip.id);
    await interaction.reply(`Playing **${clip.name}** ${clip.emoji ?? ''}`.trim());
  },
};
