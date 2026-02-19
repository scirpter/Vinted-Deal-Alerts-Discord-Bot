import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { deleteSubscription } from '../../services/subscription-service.js';
import { resolveSubscriptionReference } from './subscription-resolve.js';

export async function runSetupSubscriptionRemove(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Dieser Befehl kann nur auf einem Server verwendet werden.');
    return;
  }

  const subscriptionInput = interaction.options.getString('subscription', true);
  const resolved = await resolveSubscriptionReference({
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
    raw: subscriptionInput,
  });
  if (resolved.isErr()) {
    await interaction.editReply(resolved.error.message);
    return;
  }

  const res = await deleteSubscription({
    id: resolved.value.id,
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
  });

  if (res.isErr()) {
    await interaction.editReply(res.error.message);
    return;
  }

  await interaction.editReply(
    `Abo entfernt: **${resolved.value.label}** (Kanal: <#${resolved.value.discordChannelId}>).`,
  );
}
