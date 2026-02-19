import { REST, Routes } from 'discord.js';
import { env } from '../env.js';
import { commands } from '../commands/index.js';
import { logger } from '../logger.js';

const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
const argv = process.argv.slice(2);

const body = commands.map((c) => c.data.toJSON());

function readArgValue(name: string): string | undefined {
  const direct = argv.find((a) => a.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);

  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

async function listGuildIdsForCurrentToken(): Promise<string[]> {
  const guildIds = new Set<string>();
  let before: string | undefined;

  while (true) {
    const query = new URLSearchParams({ limit: '200' });
    if (before) query.set('before', before);

    const route = `${Routes.userGuilds()}?${query.toString()}` as `/${string}`;
    const page = (await rest.get(route)) as Array<{ id?: string }>;

    if (!Array.isArray(page) || page.length === 0) break;

    for (const guild of page) {
      if (typeof guild.id === 'string' && guild.id.length > 0) {
        guildIds.add(guild.id);
      }
    }

    if (page.length < 200) break;

    const lastGuildId = page.at(-1)?.id;
    if (typeof lastGuildId !== 'string' || lastGuildId.length === 0) break;
    before = lastGuildId;
  }

  return [...guildIds];
}

function requireGuildId(guildId: string | undefined, reason: string): string {
  if (!guildId) {
    throw new Error(`${reason}: Bitte setze DISCORD_GUILD_ID oder nutze --guild-id <id>.`);
  }
  return guildId;
}

type DeployScope = 'global' | 'guild';

const scopeArg = readArgValue('--scope');
const deployScope: DeployScope =
  scopeArg === 'global' || scopeArg === 'guild'
    ? scopeArg
    : env.DISCORD_GUILD_ID
      ? 'guild'
      : 'global';

const guildId = readArgValue('--guild-id') ?? env.DISCORD_GUILD_ID;

const shouldClearAllGuilds = hasFlag('--clear-all-guilds') || hasFlag('--clear-all');
const shouldClearGlobal = hasFlag('--clear-global') || hasFlag('--clear') || shouldClearAllGuilds;
const shouldClearGuild = hasFlag('--clear-guild') || (hasFlag('--clear') && !shouldClearAllGuilds);
const noDeploy = hasFlag('--no-deploy');

try {
  if (shouldClearGlobal) {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] });
    logger.info({ scope: 'global' }, 'Cleared commands');
  }

  if (shouldClearGuild) {
    const ensuredGuildId = requireGuildId(guildId, 'Konnte Guild-Commands nicht löschen');
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, ensuredGuildId), { body: [] });
    logger.info({ scope: 'guild', guildId: ensuredGuildId }, 'Cleared commands');
  }

  if (shouldClearAllGuilds) {
    const guildIds = await listGuildIdsForCurrentToken();
    logger.info({ guildCount: guildIds.length }, 'Clearing commands for all guilds');

    for (const currentGuildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, currentGuildId), {
        body: [],
      });
      logger.info({ scope: 'guild', guildId: currentGuildId }, 'Cleared commands');
    }
  }

  if (noDeploy) process.exit(0);

  if (deployScope === 'guild') {
    const ensuredGuildId = requireGuildId(guildId, 'Konnte Guild-Commands nicht deployen');
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, ensuredGuildId), { body });
    logger.info({ scope: 'guild', guildId: ensuredGuildId }, 'Deployed commands');
  } else {
    await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
    logger.info({ scope: 'global' }, 'Deployed commands');
  }
} catch (e: unknown) {
  logger.error({ err: e }, 'Deploy commands failed');
  process.exitCode = 1;
}
