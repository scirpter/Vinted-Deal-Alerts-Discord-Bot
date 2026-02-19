import { ChannelType, SlashCommandBuilder } from 'discord.js';
import type { Command } from './command.js';
import { runSetupAccount } from './setup/account.js';
import { runSetupHelp } from './setup/help.js';
import { runSetupSubscriptionAdd } from './setup/subscription-add.js';
import { runSetupSubscriptionFilters } from './setup/subscription-filters.js';
import { runSetupSubscriptionList } from './setup/subscription-list.js';
import { runSetupSubscriptionRemove } from './setup/subscription-remove.js';
import { autocompleteSubscription } from './setup/subscription-autocomplete.js';

export const setupCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Richte deine Vinted-Deal-Alerts ein (privat, pro Nutzer).')
    .addSubcommand((sub) =>
      sub
        .setName('account')
        .setDescription('Verbinde dein Vinted-Konto (Region + Refresh-Token).')
        .addStringOption((opt) =>
          opt
            .setName('region')
            .setDescription('Vinted-Region (Domain).')
            .setRequired(true)
            .addChoices(
              { name: 'vinted.de', value: 'de' },
              { name: 'vinted.at', value: 'at' },
              { name: 'vinted.fr', value: 'fr' },
              { name: 'vinted.it', value: 'it' },
              { name: 'vinted.es', value: 'es' },
              { name: 'vinted.nl', value: 'nl' },
              { name: 'vinted.pl', value: 'pl' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('help').setDescription('Kurzanleitung und Tipps.'),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('subscription')
        .setDescription('Verwalte deine Abos auf diesem Server.')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Abo hinzufügen (Vinted-Such-URL einfügen).')
            .addStringOption((opt) =>
              opt
                .setName('search_url')
                .setDescription('Vinted-Such-URL (beliebige Filter).')
                .setRequired(true),
            )
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setDescription(
                  'Kanal zum Posten. Wenn leer, erstellt der Bot einen privaten Kanal.',
                )
                .addChannelTypes(ChannelType.GuildText),
            )
            .addStringOption((opt) =>
              opt
                .setName('label')
                .setDescription('Name für dieses Abo (für Liste/Entfernen).'),
            )
            .addBooleanOption((opt) =>
              opt
                .setName('autobuy')
                .setDescription(
                  'Experimentell: automatischer Checkout für neue passende Artikel.',
                ),
            )
            .addStringOption((opt) =>
              opt
                .setName('include_words')
                .setDescription(
                  'Zusätzliche positive Filterwörter (Komma/Zeilen getrennt).',
                ),
            )
            .addStringOption((opt) =>
              opt
                .setName('exclude_words')
                .setDescription(
                  'Zusätzliche negative Filterwörter (Komma/Zeilen getrennt).',
                ),
            )
            .addNumberOption((opt) =>
              opt
                .setName('min_price')
                .setDescription('Min. Preis in EUR (zusätzlicher Filter).')
                .setMinValue(0),
            )
            .addNumberOption((opt) =>
              opt
                .setName('max_price')
                .setDescription('Max. Preis in EUR (zusätzlicher Filter).')
                .setMinValue(0),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('filters')
            .setDescription('Zusätzliche Filter für ein Abo setzen.')
            .addStringOption((opt) =>
              opt
                .setName('subscription')
                .setDescription('Abo (Autovervollständigung, Code/ID oder #Kanal).')
                .setRequired(true)
                .setAutocomplete(true),
            )
            .addBooleanOption((opt) =>
              opt.setName('clear').setDescription('Alle zusätzlichen Filter löschen.'),
            )
            .addStringOption((opt) =>
              opt
                .setName('include_words')
                .setDescription('Positive Filterwörter (Komma/Zeilen getrennt).'),
            )
            .addStringOption((opt) =>
              opt
                .setName('exclude_words')
                .setDescription('Negative Filterwörter (Komma/Zeilen getrennt).'),
            )
            .addNumberOption((opt) =>
              opt
                .setName('min_price')
                .setDescription('Min. Preis in EUR.')
                .setMinValue(0),
            )
            .addNumberOption((opt) =>
              opt
                .setName('max_price')
                .setDescription('Max. Preis in EUR.')
                .setMinValue(0),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Zeige deine Abos auf diesem Server.'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Abo entfernen.')
            .addStringOption((opt) =>
              opt
                .setName('subscription')
                .setDescription('Abo (Autovervollständigung, Code/ID oder #Kanal).')
                .setRequired(true)
                .setAutocomplete(true),
            ),
        ),
    ),
  execute: async (interaction) => {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'account') {
      await runSetupAccount(interaction);
      return;
    }
    if (subcommand === 'help') {
      await runSetupHelp(interaction);
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = subcommand;

    if (group === 'subscription' && sub === 'add') {
      await runSetupSubscriptionAdd(interaction);
      return;
    }
    if (group === 'subscription' && sub === 'filters') {
      await runSetupSubscriptionFilters(interaction);
      return;
    }
    if (group === 'subscription' && sub === 'list') {
      await runSetupSubscriptionList(interaction);
      return;
    }
    if (group === 'subscription' && sub === 'remove') {
      await runSetupSubscriptionRemove(interaction);
      return;
    }

    await interaction.reply({ content: 'Unbekannte Setup-Aktion.', ephemeral: true });
  },
  autocomplete: async (interaction) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === 'subscription' && (sub === 'remove' || sub === 'filters')) {
      await autocompleteSubscription(interaction);
    }
  },
};
