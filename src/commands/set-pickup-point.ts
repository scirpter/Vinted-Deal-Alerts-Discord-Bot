import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './command.js';
import { upsertPickupPoint } from '../services/vinted-account-service.js';
import { validatePickupPoint } from '../services/pickup-point-validation.js';

export const setPickupPointCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('set_pickup_point')
    .setDescription('Setze deine Rohkoordinaten für Checkout/Autokauf.')
    .addStringOption((opt) =>
      opt
        .setName('coordinates')
        .setDescription('Rohkoordinaten im Format latitude,longitude (z. B. 52.520008,13.404954).')
        .setMinLength(3)
        .setMaxLength(40)
        .setRequired(true),
    ),
  execute: async (interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const coordinates = interaction.options.getString('coordinates', true).trim();
    const validatedCoordinates = validatePickupPoint(coordinates);
    if (validatedCoordinates.isErr()) {
      await interaction.editReply(
        `${validatedCoordinates.error.message} Es werden nur Rohkoordinaten unterstützt, keine Abholpunkt-ID oder Freitext.`,
      );
      return;
    }

    const res = await upsertPickupPoint({
      discordUserId: interaction.user.id,
      pickupPoint: validatedCoordinates.value,
    });

    if (res.isErr()) {
      await interaction.editReply(res.error.message);
      return;
    }

    await interaction.editReply(
      `Koordinaten gespeichert: \`${validatedCoordinates.value}\`. Du kannst jetzt beim Abo \`autobuy: true\` verwenden.`,
    );
  },
};
