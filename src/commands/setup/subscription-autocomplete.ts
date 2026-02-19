import type { AutocompleteInteraction } from 'discord.js';
import { listSubscriptions } from '../../services/subscription-service.js';
import { buildSubscriptionIdTokens } from './subscription-resolve.js';

export async function autocompleteSubscription(interaction: AutocompleteInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  const subs = await listSubscriptions({
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
  });

  if (subs.isErr()) {
    await interaction.respond([]);
    return;
  }

  const tokens = buildSubscriptionIdTokens(subs.value);

  const options = subs.value
    .map((s) => {
      const channelName = guild.channels.cache.get(s.discordChannelId)?.name;
      const token = tokens.get(s.id) ?? s.id;
      const tokenLower = token.toLowerCase();
      const search = [s.label, s.id, channelName].filter(Boolean).join(' ').toLowerCase();
      const channelPart = channelName ? ` #${channelName}` : '';
      return {
        search: `${search} ${tokenLower}`.trim(),
        name: `${s.label}${channelPart} (${token})`,
        value: token,
      };
    })
    .filter((s) => s.search.includes(query))
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));

  await interaction.respond(options);
}
