import { Client, Events, GatewayIntentBits } from 'discord.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { createInteractionRouter } from './interactions/router.js';
import { startVintedWatcher } from './watcher/vinted-watcher.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const interactionRouter = createInteractionRouter();

client.once(Events.ClientReady, (readyClient) => {
  logger.info({ botUser: readyClient.user.tag }, 'Bot is ready');
  startVintedWatcher(readyClient);
});

client.on(Events.InteractionCreate, (interaction) => {
  void interactionRouter(interaction);
});

await client.login(env.DISCORD_TOKEN);
