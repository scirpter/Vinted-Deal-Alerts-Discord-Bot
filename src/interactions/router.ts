import type { Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { commands } from '../commands/index.js';
import { logger } from '../logger.js';
import { handleListingActionButton } from './vinted-actions.js';
import { handleSetupAccountModal } from './vinted-setup-modal.js';
import { handleMakeOfferModal } from './vinted-offer-modal.js';

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

export function createInteractionRouter() {
  return async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commandMap.get(interaction.commandName);
        if (!command) {
          await interaction.reply({ content: 'Unbekannter Befehl.', ephemeral: true });
          return;
        }
        await command.execute(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        const command = commandMap.get(interaction.commandName);
        await command?.autocomplete?.(interaction);
        return;
      }

      if (interaction.isButton()) {
        await handleListingActionButton(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('setup:account:')) {
          await handleSetupAccountModal(interaction);
          return;
        }
        if (interaction.customId.startsWith('offer:')) {
          await handleMakeOfferModal(interaction);
          return;
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Interaction handler error');
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction
            .editReply({
              content: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
            })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({
              content: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined);
        }
      }
    }
  };
}
