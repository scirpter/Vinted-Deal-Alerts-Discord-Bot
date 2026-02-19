import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { parseKeywordList } from '../../services/subscription-filters.js';
import { listSubscriptions } from '../../services/subscription-service.js';
import { buildSubscriptionIdTokens } from './subscription-resolve.js';

function formatPriceCents(cents: number): string {
  const value = (cents / 100).toFixed(2);
  return value.replace(/\.00$/, '');
}

function formatFilterSummary(sub: {
  includeKeywords: string | null;
  excludeKeywords: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
}): string | null {
  const include = parseKeywordList(sub.includeKeywords);
  const exclude = parseKeywordList(sub.excludeKeywords);

  const parts: string[] = [];

  if (include.length > 0) {
    const shown = include.slice(0, 3).join(', ');
    parts.push(`+ ${shown}${include.length > 3 ? ` (+${include.length - 3})` : ''}`);
  }
  if (exclude.length > 0) {
    const shown = exclude.slice(0, 3).join(', ');
    parts.push(`- ${shown}${exclude.length > 3 ? ` (+${exclude.length - 3})` : ''}`);
  }

  if (sub.priceMinCents != null || sub.priceMaxCents != null) {
    const from = sub.priceMinCents != null ? formatPriceCents(sub.priceMinCents) : '…';
    const to = sub.priceMaxCents != null ? formatPriceCents(sub.priceMaxCents) : '…';
    parts.push(`Preis: ${from}–${to} €`);
  }

  if (parts.length === 0) return null;
  return parts.join(' | ');
}

export async function runSetupSubscriptionList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply('Dieser Befehl kann nur auf einem Server verwendet werden.');
    return;
  }

  const res = await listSubscriptions({
    discordGuildId: guild.id,
    discordUserId: interaction.user.id,
  });

  if (res.isErr()) {
    await interaction.editReply(res.error.message);
    return;
  }

  if (res.value.length === 0) {
    await interaction.editReply('In diesem Server sind keine Abos eingerichtet.');
    return;
  }

  const tokens = buildSubscriptionIdTokens(res.value);

  const description = res.value
    .map((s) => {
      const filterSummary = formatFilterSummary(s);
      const token = tokens.get(s.id) ?? s.id;
      return `• **${s.label}** → <#${s.discordChannelId}> (${s.enabled ? 'aktiviert' : 'deaktiviert'}${
        s.autobuyEnabled ? ', Autokauf' : ''
      })\n  Code: \`${token}\` | ID: \`${s.id}\`${filterSummary ? `\n  Filter: ${filterSummary}` : ''}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Deine Abos')
    .setDescription(
      `Nutze den Code bei \`filters\`/\`remove\` (oder Autovervollständigung / #Kanal).\n\n${description}`,
    );

  await interaction.editReply({ embeds: [embed] });
}
