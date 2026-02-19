import type { ModalSubmitInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { getSubscriptionById } from '../services/subscription-service.js';
import { attemptMakeOffer } from '../services/vinted-actions-service.js';

type ParsedOfferModal = { subscriptionId: string; itemId: bigint; sellerUserId?: number } | null;

function parseOfferModal(customId: string): ParsedOfferModal {
  const [, subscriptionId, itemIdRaw, sellerUserIdRaw] = customId.split(':');
  if (!subscriptionId || !itemIdRaw) return null;
  try {
    const sellerUserId =
      sellerUserIdRaw && /^\d+$/.test(sellerUserIdRaw) ? Number.parseInt(sellerUserIdRaw, 10) : undefined;
    return {
      subscriptionId,
      itemId: BigInt(itemIdRaw),
      ...(sellerUserId !== undefined ? { sellerUserId } : {}),
    };
  } catch {
    return null;
  }
}

export async function handleMakeOfferModal(interaction: ModalSubmitInteraction) {
  const parsed = parseOfferModal(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: 'Ungültiger Angebotsablauf.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subRes = await getSubscriptionById({
    id: parsed.subscriptionId,
    discordGuildId: interaction.guildId ?? '',
    discordUserId: interaction.user.id,
  });

  if (subRes.isErr()) {
    await interaction.editReply(subRes.error.message);
    return;
  }

  const amountRaw = interaction.fields.getTextInputValue('amount').trim();
  const amount = Number(amountRaw.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.editReply('Bitte gib einen gültigen Betrag ein.');
    return;
  }

  const offerInput = {
    discordUserId: interaction.user.id,
    itemId: parsed.itemId,
    ...(parsed.sellerUserId !== undefined ? { sellerUserId: parsed.sellerUserId } : {}),
    amount,
  };

  const res = await attemptMakeOffer(offerInput);

  if (res.isErr()) {
    await interaction.editReply(res.error.message);
    return;
  }

  if (res.value.sent) {
    await interaction.editReply('Angebot gesendet.');
    return;
  }

  const estimateText = res.value.estimate
    ? (() => {
        const fee = res.value.estimate.serviceFee ? ` (+${res.value.estimate.serviceFee} Gebühr)` : '';
        return ` Geschätzter Gesamtbetrag: ${res.value.estimate.total}${fee}.`;
      })()
    : '';

  if (res.value.status === 'access_denied') {
    await interaction.editReply(
      `Vinted verweigert das automatische Senden von Angeboten für dieses Konto (access_denied).${estimateText} Das ist meist eine Vinted-Konto/IP-Sperre für API-Aktionen; ein frischer \`refresh_token_web\` hilft nicht immer. Sende das Angebot direkt in Vinted.`,
    );
    return;
  }

  if (res.value.status === 'blocked') {
    await interaction.editReply(
      `Angebot wird aktuell durch Vinted-Schutzmaßnahmen blockiert.${estimateText} Bitte schließe es in der Vinted-App/auf der Website ab.`,
    );
    return;
  }

  await interaction.editReply(
    `Angebot konnte nicht automatisch gesendet werden.${estimateText} Bitte schließe es in der Vinted-App/auf der Website ab.`,
  );
}
