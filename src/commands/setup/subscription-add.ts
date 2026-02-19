import type { ChatInputCommandInteraction } from 'discord.js';
import { ChannelType, EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { ulid } from 'ulid';
import { createPrivateTextChannelForUser } from '../../interactions/private-channel.js';
import { normalizeKeywordInput, serializeKeywordList } from '../../services/subscription-filters.js';
import { ensureAccountConfigured, getAccountForUser } from '../../services/vinted-account-service.js';
import { createSubscription, listSubscriptions } from '../../services/subscription-service.js';
import { parseVintedSearchUrl } from '../../services/vinted-search.js';
import { buildSubscriptionIdTokens } from './subscription-resolve.js';

function toCents(value: number): number {
  return Math.round(value * 100);
}

export async function runSetupSubscriptionAdd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Dieser Befehl kann nur auf einem Server verwendet werden.');
    return;
  }

  const accountRes = await ensureAccountConfigured({ discordUserId: interaction.user.id });
  if (accountRes.isErr()) {
    await interaction.editReply(accountRes.error.message);
    return;
  }

  const account = await getAccountForUser({ discordUserId: interaction.user.id });
  if (account.isErr()) {
    await interaction.editReply(account.error.message);
    return;
  }

  const searchUrl = interaction.options.getString('search_url', true).trim();
  const label = interaction.options.getString('label')?.trim() ?? null;
  const autobuy = interaction.options.getBoolean('autobuy') ?? false;
  const includeWords = interaction.options.getString('include_words')?.trim() ?? null;
  const excludeWords = interaction.options.getString('exclude_words')?.trim() ?? null;
  const minPrice = interaction.options.getNumber('min_price');
  const maxPrice = interaction.options.getNumber('max_price');

  const priceMinCents = minPrice != null ? toCents(minPrice) : null;
  const priceMaxCents = maxPrice != null ? toCents(maxPrice) : null;
  if (priceMinCents != null && priceMaxCents != null && priceMinCents > priceMaxCents) {
    await interaction.editReply('Ungültige Preisspanne: min_price ist größer als max_price.');
    return;
  }

  const includeKeywords = includeWords ? serializeKeywordList(normalizeKeywordInput(includeWords)) : null;
  const excludeKeywords = excludeWords ? serializeKeywordList(normalizeKeywordInput(excludeWords)) : null;

  const parsed = parseVintedSearchUrl({ searchUrl });
  if (parsed.isErr()) {
    await interaction.editReply(parsed.error.message);
    return;
  }

  try {
    const url = new URL(searchUrl);
    if (!url.hostname.endsWith(`vinted.${account.value.region}`)) {
      await interaction.editReply(
        `Die Domain der Such-URL passt nicht zu deiner verbundenen Region (vinted.${account.value.region}). Bitte füge eine URL von der richtigen Vinted-Seite ein.`,
      );
      return;
    }
  } catch {
    await interaction.editReply('Ungültige Vinted-Such-URL.');
    return;
  }

  const providedChannel = interaction.options.getChannel('channel');
  const subscriptionId = ulid();

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    await interaction.editReply('Konnte die Bot-Berechtigungen auf diesem Server nicht ermitteln.');
    return;
  }

  let channelId: string;
  if (providedChannel) {
    if (providedChannel.type !== ChannelType.GuildText) {
      await interaction.editReply('Bitte wähle einen Textkanal aus.');
      return;
    }

    const fullChannel =
      guild.channels.cache.get(providedChannel.id) ??
      (await guild.channels.fetch(providedChannel.id).catch(() => null));

    if (!fullChannel || fullChannel.type !== ChannelType.GuildText) {
      await interaction.editReply('Bitte wähle einen Textkanal aus.');
      return;
    }

    const perms = me.permissionsIn(fullChannel);
    const missing: string[] = [];
    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push('Kanal ansehen');
    if (!perms.has(PermissionsBitField.Flags.SendMessages)) missing.push('Nachrichten senden');
    if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('Links einbetten');

    if (missing.length > 0) {
      await interaction.editReply(
        `Ich kann in <#${providedChannel.id}> nicht posten. Fehlende Berechtigungen: ${missing.join(', ')}.`,
      );
      return;
    }
    channelId = providedChannel.id;
  } else {
    if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      await interaction.editReply(
        'Fehlende Berechtigung: „Kanäle verwalten“ (Manage Channels). Wähle stattdessen einen bestehenden Kanal über die Option `channel` aus oder gib dem Bot diese Berechtigung.',
      );
      return;
    }

    const created = await createPrivateTextChannelForUser({
      guild,
      owner: interaction.user,
      nameHint: label ?? parsed.value.suggestedChannelName,
    });
    if (created.isErr()) {
      await interaction.editReply(created.error.message);
      return;
    }
    channelId = created.value.id;
  }

  const finalLabel = label ?? parsed.value.suggestedLabel;

  const created = await createSubscription({
    id: subscriptionId,
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
    discordChannelId: channelId,
    label: finalLabel,
    searchUrl,
    autobuyEnabled: autobuy,
    includeKeywords,
    excludeKeywords,
    priceMinCents,
    priceMaxCents,
  });

  if (created.isErr()) {
    await interaction.editReply(created.error.message);
    return;
  }

  let code = subscriptionId.slice(0, 8);
  const subs = await listSubscriptions({ discordGuildId: guild.id, discordUserId: interaction.user.id });
  if (subs.isOk()) {
    const tokens = buildSubscriptionIdTokens(subs.value, 8);
    code = tokens.get(subscriptionId) ?? code;
  }

  const embed = new EmbedBuilder()
    .setTitle('Abo erstellt')
    .setDescription(`Neue Artikel werden in <#${channelId}> gepostet.`)
    .addFields(
      { name: 'Label', value: finalLabel, inline: true },
      { name: 'Code', value: `\`${code}\``, inline: true },
      { name: 'Autokauf', value: autobuy ? 'aktiv' : 'aus', inline: true },
    )
    .setFooter({ text: 'Nutze den Code bei /setup subscription filters oder /setup subscription remove.' });

  await interaction.editReply({ embeds: [embed] });
}
