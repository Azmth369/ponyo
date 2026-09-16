import { SlashCommandBuilder } from 'discord.js';
import { answer } from './ai.js';
import { currentWarAnalysis } from './analytics.js';
import { sendToConfiguredChannel } from './discordChannels.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the Clash of Clans AI analyst')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('war')
    .setDescription('Show a quick current-war summary'),
  new SlashCommandBuilder()
    .setName('forward')
    .setDescription('Forward your supplied AI answer to a configured Discord channel')
    .addStringOption(o => o.setName('channel').setDescription('Configured channel name').setRequired(true))
    .addStringOption(o => o.setName('answer').setDescription('Answer to forward').setRequired(true))
].map(c => c.toJSON());

export async function handleCommand(interaction, client) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const result = await answer(interaction.options.getString('question', true));
    return interaction.editReply(result.slice(0, 1900));
  }
  if (interaction.commandName === 'war') {
    await interaction.deferReply();
    const w = await currentWarAnalysis();
    if (w.state === 'notInWar') return interaction.editReply('The clan is not currently in a war.');
    const pending = w.missed_attacks.map(m => `• ${m.player_name}`).join('\n') || 'None';
    return interaction.editReply(`**Current war:** ${w.state}\n**Members:** ${w.members.length}\n**Attacks recorded:** ${w.attacks.length}\n**Pending attacks:**\n${pending}`.slice(0, 1900));
  }
  if (interaction.commandName === 'forward') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getString('channel', true);
    const content = interaction.options.getString('answer', true);
    await sendToConfiguredChannel(client, channel, content);
    return interaction.editReply(`Forwarded to configured channel '${channel}'.`);
  }
}
