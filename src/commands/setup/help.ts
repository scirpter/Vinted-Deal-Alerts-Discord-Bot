import type { ChatInputCommandInteraction } from 'discord.js';
import { EmbedBuilder, MessageFlags } from 'discord.js';

export async function runSetupHelp(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('Kreziax - Kurzanleitung')
    .setDescription('So richtest du Vinted-Alerts in wenigen Minuten ein:')
    .addFields(
      {
        name: '1) Konto verbinden',
        value:
          '`/setup account` -> Region wählen -> Refresh-Token einfügen (Cookie `refresh_token_web` nach dem Login).',
      },
      {
        name: '2) Abo hinzufügen',
        value:
          '`/setup subscription add` -> Vinted-Such-URL einfügen (du kannst alle Vinted-Filter nutzen). Optional: Kanal + Label.',
      },
      {
        name: '3) Filter anpassen',
        value:
          '`/setup subscription filters` -> Abo über Autovervollständigung auswählen oder den Code aus `/setup subscription list` nutzen. Tipp: Du kannst auch den Kanal erwähnen (z. B. #vinted-angebote).',
      },
      {
        name: 'Abos verwalten',
        value:
          '`/setup subscription list` zeigt deine Abos inkl. Code.\n`/setup subscription remove` entfernt ein Abo.',
      },
      {
        name: 'Koordinaten',
        value:
          '`/set_pickup_point` speichert Rohkoordinaten im Format `latitude,longitude` (z. B. `52.520008,13.404954`). Die Antwort zeigt den gespeicherten Wert direkt an.',
      },
      {
        name: 'Wenn Aktionen fehlschlagen',
        value:
          'Bei `access_denied` oder wiederholten Blocks: `/setup account` mit frischem `refresh_token_web` erneut ausführen, Region prüfen und Aktion notfalls direkt in Vinted abschließen.',
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
