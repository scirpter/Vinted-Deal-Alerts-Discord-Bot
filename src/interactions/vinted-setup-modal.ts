import type { ModalSubmitInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { upsertAccountFromRefreshToken } from '../services/vinted-account-service.js';
import { clearTokenStateForUser } from '../services/vinted-token-service.js';

export async function handleSetupAccountModal(interaction: ModalSubmitInteraction) {
  const [, , region] = interaction.customId.split(':');
  if (!region) {
    await interaction.reply({ content: 'Region fehlt.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const refreshToken = interaction.fields.getTextInputValue('refresh_token').trim();
  if (!refreshToken) {
    await interaction.editReply('Refresh-Token darf nicht leer sein.');
    return;
  }

  const res = await upsertAccountFromRefreshToken({
    discordUserId: interaction.user.id,
    region,
    refreshToken,
  });

  if (res.isErr()) {
    await interaction.editReply(res.error.message);
    return;
  }

  clearTokenStateForUser({ discordUserId: interaction.user.id });
  await interaction.editReply('Vinted-Konto verbunden. Als Nächstes: `/setup subscription add`');
}
