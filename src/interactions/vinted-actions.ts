import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import { getSubscriptionById } from '../services/subscription-service.js';
import {
  attemptInstantBuy,
  toggleFavourite,
} from '../services/vinted-actions-service.js';

type ParsedAction =
  | { type: 'like'; subscriptionId: string; itemId: bigint }
  | { type: 'buy'; subscriptionId: string; itemId: bigint; sellerUserId?: number }
  | { type: 'offer'; subscriptionId: string; itemId: bigint; sellerUserId?: number };

function parseAction(customId: string): ParsedAction | null {
  const [type, subscriptionId, itemIdRaw, sellerUserIdRaw] = customId.split(':');
  if (!type || !subscriptionId || !itemIdRaw) return null;
  try {
    const itemId = BigInt(itemIdRaw);
    const sellerUserId =
      sellerUserIdRaw && /^\d+$/.test(sellerUserIdRaw) ? Number.parseInt(sellerUserIdRaw, 10) : undefined;
    if (type === 'like') return { type: 'like', subscriptionId, itemId };
    if (type === 'buy') {
      return {
        type: 'buy',
        subscriptionId,
        itemId,
        ...(sellerUserId !== undefined ? { sellerUserId } : {}),
      };
    }
    if (type === 'offer') {
      return {
        type: 'offer',
        subscriptionId,
        itemId,
        ...(sellerUserId !== undefined ? { sellerUserId } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleListingActionButton(interaction: ButtonInteraction) {
  const parsed = parseAction(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: 'Unbekannte Aktion.', flags: MessageFlags.Ephemeral });
    return;
  }

  const subRes = await getSubscriptionById({
    id: parsed.subscriptionId,
    discordGuildId: interaction.guildId ?? '',
    discordUserId: interaction.user.id,
  });

  if (subRes.isErr()) {
    await interaction.reply({ content: subRes.error.message, flags: MessageFlags.Ephemeral });
    return;
  }

  if (parsed.type === 'like') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await toggleFavourite({
      discordUserId: interaction.user.id,
      itemId: parsed.itemId,
    });

    if (res.isErr()) {
      await interaction.editReply(res.error.message);
      return;
    }

    if (!res.value.known) {
      await interaction.editReply('Favorit erfolgreich aktualisiert.');
      return;
    }

    await interaction.editReply(res.value.liked ? 'Zu Favoriten hinzugefügt.' : 'Aus Favoriten entfernt.');
    return;
  }

  if (parsed.type === 'buy') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const buyInput = {
      discordUserId: interaction.user.id,
      itemId: parsed.itemId,
      ...(parsed.sellerUserId !== undefined ? { sellerUserId: parsed.sellerUserId } : {}),
    };
    const res = await attemptInstantBuy(buyInput);

    if (res.isErr()) {
      await interaction.editReply(res.error.message);
      return;
    }

    if (res.value.status === 'purchased' || res.value.status === 'purchased_without_pickup') {
      const suffix =
        res.value.status === 'purchased_without_pickup'
          ? ' Der Kauf lief ohne gespeicherte Koordinaten; setze `/set_pickup_point` neu.'
          : '';
      await interaction.editReply(`Kauf wurde direkt ausgelöst.${suffix}`);
      return;
    }

    if (res.value.status === 'manual_checkout_required') {
      await interaction.editReply(
        'Direktkauf konnte nicht finalisiert werden. Vinted verlangt für diesen Kauf weiterhin den manuellen Abschluss in App/Web.',
      );
      return;
    }

    if (res.value.status === 'blocked') {
      await interaction.editReply(
        'Checkout wird aktuell durch Vinted-Schutzmaßnahmen blockiert. Bitte schließe den Kauf in Vinted ab.',
      );
      return;
    }

    if (res.value.status === 'access_denied') {
      await interaction.editReply(
        'Vinted verweigert diesen Checkout für dein Konto (access_denied). Das ist meist eine Vinted-Konto/IP-Sperre für API-Aktionen; ein frischer `refresh_token_web` hilft nicht immer.',
      );
      return;
    }

    if (res.value.status === 'invalid_pickup_point') {
      await interaction.editReply(
        'Deine gespeicherten Koordinaten sind ungültig. Setze sie mit `/set_pickup_point` neu und versuche es erneut.',
      );
      return;
    }

    if (res.value.status === 'failed') {
      await interaction.editReply(
        'Checkout konnte gerade nicht erstellt werden. Bitte versuche es erneut oder schließe den Kauf direkt in Vinted ab.',
      );
      return;
    }
    return;
  }

  if (parsed.type === 'offer') {
    const sellerUserIdPart = parsed.sellerUserId ? `:${parsed.sellerUserId.toString()}` : '';
    const modal = new ModalBuilder()
      .setCustomId(`offer:${parsed.subscriptionId}:${parsed.itemId.toString()}${sellerUserIdPart}`)
      .setTitle('Angebot machen');

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Angebotsbetrag (z. B. 12,50)')
      .setRequired(true)
      .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
    await interaction.showModal(modal);
  }
}
