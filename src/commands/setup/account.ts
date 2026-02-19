import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

export async function runSetupAccount(interaction: ChatInputCommandInteraction) {
  const region = interaction.options.getString('region', true);

  const refreshTokenInput = new TextInputBuilder()
    .setCustomId('refresh_token')
    .setLabel('Vinted Refresh-Token (refresh_token_web)')
    .setPlaceholder('Cookie-Wert hier einfügen')
    .setRequired(true)
    .setStyle(TextInputStyle.Paragraph);

  const modal = new ModalBuilder()
    .setCustomId(`setup:account:${region}`)
    .setTitle('Vinted-Konto verbinden')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(refreshTokenInput));

  await interaction.showModal(modal);
}
