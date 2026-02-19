import type { ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { normalizeKeywordInput, serializeKeywordList } from '../../services/subscription-filters.js';
import { updateSubscriptionFilters } from '../../services/subscription-service.js';
import { resolveSubscriptionReference } from './subscription-resolve.js';

function toCents(value: number): number {
  return Math.round(value * 100);
}

export async function runSetupSubscriptionFilters(interaction: ChatInputCommandInteraction) {
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
  const subscription = resolved.value;
  const clear = interaction.options.getBoolean('clear') ?? false;

  if (clear) {
    const res = await updateSubscriptionFilters({
      id: subscription.id,
      discordGuildId: guild.id,
      discordUserId: interaction.user.id,
      includeKeywords: null,
      excludeKeywords: null,
      priceMinCents: null,
      priceMaxCents: null,
    });

    if (res.isErr()) {
      await interaction.editReply(res.error.message);
      return;
    }

    await interaction.editReply(
      `Filter wurden gelöscht für **${subscription.label}**. (Übersicht: \`/setup subscription list\`)`,
    );
    return;
  }

  const includeWordsRaw = interaction.options.getString('include_words');
  const excludeWordsRaw = interaction.options.getString('exclude_words');
  const minPrice = interaction.options.getNumber('min_price');
  const maxPrice = interaction.options.getNumber('max_price');

  if (includeWordsRaw == null && excludeWordsRaw == null && minPrice == null && maxPrice == null) {
    await interaction.editReply(
      'Keine Änderungen angegeben. Setze mindestens einen Filter oder nutze `clear`, um alles zu löschen.',
    );
    return;
  }

  const patch: {
    includeKeywords?: string | null;
    excludeKeywords?: string | null;
    priceMinCents?: number | null;
    priceMaxCents?: number | null;
  } = {};

  if (includeWordsRaw != null) {
    patch.includeKeywords = serializeKeywordList(normalizeKeywordInput(includeWordsRaw));
  }
  if (excludeWordsRaw != null) {
    patch.excludeKeywords = serializeKeywordList(normalizeKeywordInput(excludeWordsRaw));
  }
  if (minPrice != null) patch.priceMinCents = toCents(minPrice);
  if (maxPrice != null) patch.priceMaxCents = toCents(maxPrice);

  const nextMin = patch.priceMinCents ?? subscription.priceMinCents;
  const nextMax = patch.priceMaxCents ?? subscription.priceMaxCents;
  if (nextMin != null && nextMax != null && nextMin > nextMax) {
    await interaction.editReply('Ungültige Preisspanne: min_price ist größer als max_price.');
    return;
  }

  const res = await updateSubscriptionFilters({
    id: subscription.id,
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
    ...patch,
  });

  if (res.isErr()) {
    await interaction.editReply(res.error.message);
    return;
  }

  await interaction.editReply(
    `Filter gespeichert für **${subscription.label}**. (Übersicht: \`/setup subscription list\`)`,
  );
}
