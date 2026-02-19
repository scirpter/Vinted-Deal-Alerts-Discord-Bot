import { logger } from '../logger.js';

type SendableChannel = { send: (content: string) => Promise<unknown> };
type DmUser = { send: (content: string) => Promise<unknown> };

type NotifierClient = {
  channels: { fetch: (id: string) => Promise<unknown> };
  users: { fetch: (id: string) => Promise<DmUser> };
};

export type SetupRequiredNotificationSubscription = {
  id: string;
  discordUserId: string;
  discordChannelId: string;
};

const channelNotifiedUntilBySubscriptionId = new Map<string, number>();
const dmNotifiedUntilByUserId = new Map<string, number>();

const CHANNEL_COOLDOWN_MS = 60 * 60 * 1000;
const DM_COOLDOWN_MS = 60 * 60 * 1000;

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return typeof (channel as any)?.send === 'function';
}

function isUnknownChannelError(error: unknown): boolean {
  const anyErr = error as any;
  return (
    anyErr?.code === 10003 ||
    anyErr?.rawError?.code === 10003 ||
    (typeof anyErr?.message === 'string' && anyErr.message.toLowerCase().includes('unknown channel'))
  );
}

function isCannotSendDmError(error: unknown): boolean {
  const anyErr = error as any;
  return (
    anyErr?.code === 50007 ||
    anyErr?.rawError?.code === 50007 ||
    (typeof anyErr?.message === 'string' &&
      anyErr.message.toLowerCase().includes('cannot send messages to this user'))
  );
}

function defaultChannelMessage(discordUserId: string): string {
  return `⛔ <@${discordUserId}> Vinted-Token ungültig/abgelaufen. Bitte führe \`/setup account\` mit einem frischen \`refresh_token_web\` erneut aus, damit neue Treffer wieder verarbeitet werden.`;
}

function defaultDmMessage(): string {
  return (
    '⛔ Dein Vinted-Token ist ungültig oder abgelaufen. ' +
    'Bitte führe `/setup account` mit einem frischen `refresh_token_web` erneut aus. '
  );
}

export async function notifySetupRequiredIfNeeded(input: {
  client: NotifierClient;
  subscription: SetupRequiredNotificationSubscription;
  now?: number;
  channelMessage?: string;
  dmMessage?: string;
  onUnknownChannel?: () => Promise<void>;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const channelDue =
    now >= (channelNotifiedUntilBySubscriptionId.get(input.subscription.id) ?? 0);
  const dmDue = now >= (dmNotifiedUntilByUserId.get(input.subscription.discordUserId) ?? 0);

  if (!channelDue && !dmDue) return;

  const channelMessage = input.channelMessage ?? defaultChannelMessage(input.subscription.discordUserId);
  const dmMessage = input.dmMessage ?? defaultDmMessage();

  if (channelDue) {
    try {
      const channel = await input.client.channels.fetch(input.subscription.discordChannelId);
      if (channel && isSendableChannel(channel)) {
        await channel.send(channelMessage);
      } else {
        logger.warn(
          { subscriptionId: input.subscription.id, channelId: input.subscription.discordChannelId },
          'Setup-required notice skipped: channel not sendable',
        );
      }
    } catch (e: unknown) {
      if (isUnknownChannelError(e)) {
        await input.onUnknownChannel?.();
      } else {
        logger.warn(
          { err: e, subscriptionId: input.subscription.id, channelId: input.subscription.discordChannelId },
          'Setup-required channel notice failed',
        );
      }
    } finally {
      channelNotifiedUntilBySubscriptionId.set(input.subscription.id, now + CHANNEL_COOLDOWN_MS);
    }
  }

  if (dmDue) {
    try {
      const user = await input.client.users.fetch(input.subscription.discordUserId);
      await user.send(dmMessage);
    } catch (e: unknown) {
      if (isCannotSendDmError(e)) {
        logger.info(
          { discordUserId: input.subscription.discordUserId },
          'Setup-required DM skipped: cannot message user',
        );
      } else {
        logger.warn(
          { err: e, discordUserId: input.subscription.discordUserId },
          'Setup-required DM failed',
        );
      }
    } finally {
      dmNotifiedUntilByUserId.set(input.subscription.discordUserId, now + DM_COOLDOWN_MS);
    }
  }
}
