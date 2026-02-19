import type { Client } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import PQueue from 'p-queue';
import { env } from '../env.js';
import { logger } from '../logger.js';
import {
  deleteSubscription,
  listAllEnabledSubscriptions,
  updateSubscriptionLastSeen,
} from '../services/subscription-service.js';
import { parseKeywordList } from '../services/subscription-filters.js';
import { getAccessTokenForUser } from '../services/vinted-token-service.js';
import { VintedClient } from '../infra/vinted/vinted-client.js';
import { getSellerInfo } from '../services/vinted-user-cache.js';
import { attemptInstantBuy } from '../services/vinted-actions-service.js';
import { notifySetupRequiredIfNeeded } from '../services/setup-required-notifier.js';

const vinted = new VintedClient();
const queue = new PQueue({ concurrency: env.WATCH_CONCURRENCY });
const inFlightSubscriptions = new Set<string>();
const blockedUntilBySubscriptionId = new Map<string, { until: number; strikes: number }>();
let nextCatalogFetchAtMs = 0;

function isSendableChannel(
  channel: unknown,
): channel is { send: (...args: any[]) => Promise<unknown> } {
  return typeof (channel as any)?.send === 'function';
}

function formatRelative(date: Date): string {
  const unixSeconds = Math.floor(date.getTime() / 1000);
  return `<t:${unixSeconds}:R>`;
}

function parseVintedPriceToCents(amount: string): number | null {
  const trimmed = amount.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(',', '.');
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const whole = Number.parseInt(match[1]!, 10);
  const frac = match[2] ?? '';
  const cents = Number.parseInt((frac + '00').slice(0, 2), 10);
  if (!Number.isFinite(whole) || !Number.isFinite(cents)) return null;

  return whole * 100 + cents;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCatalogFetchSlot(): Promise<void> {
  const spacingMs = env.WATCH_FETCH_DELAY_MS;
  if (spacingMs <= 0) return;

  const now = Date.now();
  const waitMs = Math.max(0, nextCatalogFetchAtMs - now);
  nextCatalogFetchAtMs = Math.max(nextCatalogFetchAtMs, now) + spacingMs;
  if (waitMs > 0) await sleep(waitMs);
}

function isUnknownChannelError(error: unknown): boolean {
  const anyErr = error as any;
  return (
    anyErr?.code === 10003 ||
    anyErr?.rawError?.code === 10003 ||
    (typeof anyErr?.message === 'string' && anyErr.message.toLowerCase().includes('unknown channel'))
  );
}

function isVintedBlockedError(message: string): boolean {
  return message.includes('(403)') || message.toLowerCase().includes('blockiert');
}

function isSetupRequiredTokenError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid_grant') || lower.includes('abgelaufen') || message.includes('/setup account');
}

function markSubscriptionBackoff(input: {
  subscriptionId: string;
  reason: 'blocked' | 'setup_required';
  baseDelayMs: number;
  maxDelayMs: number;
}): void {
  const prev = blockedUntilBySubscriptionId.get(input.subscriptionId);
  const strikes = Math.min((prev?.strikes ?? 0) + 1, 6);
  const delayMs = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** strikes);
  blockedUntilBySubscriptionId.set(input.subscriptionId, { until: Date.now() + delayMs, strikes });
  logger.warn({ subscriptionId: input.subscriptionId, delayMs, reason: input.reason }, 'Subscription backoff');
}

function markSubscriptionBlocked(subscriptionId: string): void {
  markSubscriptionBackoff({
    subscriptionId,
    reason: 'blocked',
    baseDelayMs: 30_000,
    maxDelayMs: 30 * 60_000,
  });
}

function markSubscriptionSetupRequired(subscriptionId: string): void {
  markSubscriptionBackoff({
    subscriptionId,
    reason: 'setup_required',
    baseDelayMs: 5 * 60_000,
    maxDelayMs: 60 * 60_000,
  });
}

async function deleteSubscriptionForMissingChannel(
  sub: Awaited<ReturnType<typeof listAllEnabledSubscriptions>>[number],
) {
  const deleted = await deleteSubscription({
    id: sub.id,
    discordGuildId: sub.discordGuildId,
    discordUserId: sub.discordUserId,
  });
  if (deleted.isErr()) {
    logger.warn({ err: deleted.error, subscriptionId: sub.id }, 'Failed to delete subscription');
    return;
  }
  logger.info({ subscriptionId: sub.id, channelId: sub.discordChannelId }, 'Deleted subscription');
}

export function startVintedWatcher(client: Client) {
  const intervalMs = env.WATCH_INTERVAL_MS;
  const run = () =>
    tick(client).catch((e: unknown) => {
      logger.error({ err: e }, 'Watcher tick failed');
    });

  const loop = async () => {
     
    while (true) {
      const startedAt = Date.now();
      await run();
      const elapsedMs = Date.now() - startedAt;
      await sleep(Math.max(0, intervalMs - elapsedMs));
    }
  };

  void loop();
}

async function tick(client: Client) {
  const now = Date.now();
  const subs = await listAllEnabledSubscriptions();
  const actionable = subs.filter((s) => {
    if (inFlightSubscriptions.has(s.id)) return false;
    const blocked = blockedUntilBySubscriptionId.get(s.id);
    return !blocked || blocked.until <= now;
  });
  await Promise.all(
    actionable.map((sub) =>
      queue.add(async () => {
        inFlightSubscriptions.add(sub.id);
        try {
          await processSubscription(client, sub).catch((e: unknown) => {
            logger.warn({ err: e, subscriptionId: sub.id }, 'Subscription tick failed');
          });
        } finally {
          inFlightSubscriptions.delete(sub.id);
        }
      }),
    ),
  );
}

async function processSubscription(
  client: Client,
  sub: Awaited<ReturnType<typeof listAllEnabledSubscriptions>>[number],
) {
  const token = await getAccessTokenForUser({ discordUserId: sub.discordUserId });
  if (token.isErr()) {
    if (isVintedBlockedError(token.error.message)) markSubscriptionBlocked(sub.id);
    if (isSetupRequiredTokenError(token.error.message)) {
      markSubscriptionSetupRequired(sub.id);
      await notifySetupRequiredIfNeeded({
        client,
        subscription: {
          id: sub.id,
          discordUserId: sub.discordUserId,
          discordChannelId: sub.discordChannelId,
        },
        onUnknownChannel: async () => deleteSubscriptionForMissingChannel(sub),
      });
    }
    logger.warn({ err: token.error, subscriptionId: sub.id }, 'Token unavailable');
    return;
  }

  const includeWords = parseKeywordList(sub.includeKeywords);
  const excludeWords = parseKeywordList(sub.excludeKeywords);
  const priceMinCents = sub.priceMinCents ?? null;
  const priceMaxCents = sub.priceMaxCents ?? null;

  const matchesFilters = (item: { title: string; price: { amount: string } }): boolean => {
    const title = item.title.toLowerCase();
    if (includeWords.length > 0 && !includeWords.some((w) => title.includes(w))) return false;
    if (excludeWords.some((w) => title.includes(w))) return false;

    if (priceMinCents != null || priceMaxCents != null) {
      const cents = parseVintedPriceToCents(item.price.amount);
      if (cents == null) return false;
      if (priceMinCents != null && cents < priceMinCents) return false;
      if (priceMaxCents != null && cents > priceMaxCents) return false;
    }

    return true;
  };

  const perPage = 20;
  const maxPages = 25;

  const fetchPage = async (page: number) => {
    await waitForCatalogFetchSlot();
    return vinted.searchCatalog({
      region: token.value.region,
      accessToken: token.value.accessToken,
      searchUrl: sub.searchUrl,
      page,
      perPage,
      sessionKey: sub.discordUserId,
    });
  };

  const firstRes = await fetchPage(1);
  if (firstRes.isErr()) {
    if (isVintedBlockedError(firstRes.error.message)) markSubscriptionBlocked(sub.id);
    logger.warn({ err: firstRes.error, subscriptionId: sub.id }, 'Catalog fetch failed');
    return;
  }

  const firstItems = firstRes.value;
  if (firstItems.length === 0) return;

  const maxId = firstItems.reduce((m, i) => (i.id > m ? i.id : m), firstItems[0]!.id);

  if (!sub.lastSeenItemId) {
    await updateSubscriptionLastSeen({ id: sub.id, lastSeenItemId: maxId });
    return;
  }

  const lastSeen = sub.lastSeenItemId;
  const collected = new Map<string, (typeof firstItems)[number]>();

  let pageItems = firstItems;
  let minIdInPage = pageItems.reduce((m, i) => (i.id < m ? i.id : m), pageItems[0]!.id);
  for (const item of pageItems) {
    if (item.id > lastSeen) collected.set(item.id.toString(), item);
  }

  let page = 1;
  while (minIdInPage > lastSeen && page < maxPages && pageItems.length === perPage) {
    page += 1;
    const pageRes = await fetchPage(page);
    if (pageRes.isErr()) {
      if (isVintedBlockedError(pageRes.error.message)) markSubscriptionBlocked(sub.id);
      logger.warn({ err: pageRes.error, subscriptionId: sub.id, page }, 'Catalog fetch failed');
      return;
    }

    pageItems = pageRes.value;
    if (pageItems.length === 0) break;

    minIdInPage = pageItems.reduce((m, i) => (i.id < m ? i.id : m), pageItems[0]!.id);
    for (const item of pageItems) {
      if (item.id > lastSeen) collected.set(item.id.toString(), item);
    }
  }

  const newItems = Array.from(collected.values()).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (newItems.length === 0) return;

  let channel: unknown = null;
  try {
    channel = await client.channels.fetch(sub.discordChannelId);
  } catch (e: unknown) {
    if (isUnknownChannelError(e)) {
      await deleteSubscriptionForMissingChannel(sub);
      return;
    }

    logger.warn({ err: e, channelId: sub.discordChannelId, subscriptionId: sub.id }, 'Channel fetch failed');
    return;
  }
  if (!channel || !isSendableChannel(channel)) {
    logger.warn({ channelId: sub.discordChannelId }, 'Channel not found/text-based');
    return;
  }

  let lastHandledItemId: bigint | null = null;
  for (const item of newItems) {
    if (!matchesFilters(item)) {
      lastHandledItemId = item.id;
      continue;
    }

    const seller = await getSellerInfo({
      region: token.value.region,
      accessToken: token.value.accessToken,
      userId: item.user.id,
    });

    const rating =
      seller?.feedbackReputation != null
        ? `${(seller.feedbackReputation * 5).toFixed(1)} / 5${
            seller.feedbackCount != null ? ` (${seller.feedbackCount})` : ''
          }`
        : 'k. A.';

    const embed = new EmbedBuilder()
      .setTitle(item.title)
      .setURL(item.url)
      .setTimestamp(new Date())
      .addFields(
        {
          name: 'ðŸ”„ Aktualisiert',
          value: item.updatedAt ? formatRelative(item.updatedAt) : 'k. A.',
          inline: true,
        },
        { name: 'ðŸ“ GrÃ¶ÃŸe', value: item.size_title || 'k. A.', inline: true },
        { name: 'ðŸ§¼ Zustand', value: item.status || 'k. A.', inline: true },
        { name: 'â­ Bewertung', value: rating, inline: true },
        { name: 'ðŸ’° Preis', value: `${item.price.amount} ${item.price.currency_code}`, inline: true },
      );
    if (item.photoUrl) {
      embed.setThumbnail(item.photoUrl);
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ansehen').setURL(item.url),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setLabel('Jetzt kaufen')
        .setCustomId(`buy:${sub.id}:${item.id.toString()}:${item.user.id.toString()}`),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel('Angebot machen')
        .setCustomId(`offer:${sub.id}:${item.id.toString()}:${item.user.id.toString()}`),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setLabel('Favorisieren')
        .setCustomId(`like:${sub.id}:${item.id.toString()}`),
    );

    try {
      await channel.send({ embeds: [embed], components: [row] });
      lastHandledItemId = item.id;
    } catch (e: unknown) {
      if (isUnknownChannelError(e)) {
        await deleteSubscriptionForMissingChannel(sub);
        return;
      }
      logger.warn({ err: e, subscriptionId: sub.id }, 'Channel send failed');
      if (lastHandledItemId !== null) {
        await updateSubscriptionLastSeen({ id: sub.id, lastSeenItemId: lastHandledItemId });
      }
      return;
    }

    if (sub.autobuyEnabled) {
      const buy = await attemptInstantBuy({
        discordUserId: sub.discordUserId,
        itemId: item.id,
        sellerUserId: item.user.id,
      });

      if (buy.isErr()) {
        logger.warn(
          { subscriptionId: sub.id, itemId: item.id.toString(), err: buy.error },
          'Autobuy failed before classification',
        );
        try {
          await channel.send(
            'Autokauf: Direktkauf konnte nicht gestartet werden. Bitte prüfe `/setup account` und versuche es erneut.',
          );
        } catch (e: unknown) {
          if (isUnknownChannelError(e)) {
            await deleteSubscriptionForMissingChannel(sub);
            return;
          }
          logger.warn({ err: e, subscriptionId: sub.id }, 'Channel send failed');
          continue;
        }
        continue;
      }

      logger.info(
        { subscriptionId: sub.id, itemId: item.id.toString(), buyStatus: buy.value.status },
        'Autobuy status',
      );

      if (buy.value.status === 'purchased' || buy.value.status === 'purchased_without_pickup') {
        const content =
          buy.value.status === 'purchased_without_pickup'
            ? 'Autokauf: Kauf direkt ausgelöst (ohne gespeicherte Koordinaten). Bitte setze `/set_pickup_point` neu.'
            : 'Autokauf: Kauf direkt ausgelöst.';

        try {
          await channel.send(content);
        } catch (e: unknown) {
          if (isUnknownChannelError(e)) {
            await deleteSubscriptionForMissingChannel(sub);
            return;
          }
          logger.warn({ err: e, subscriptionId: sub.id }, 'Channel send failed');
          continue;
        }
        continue;
      }

      if (buy.value.status === 'manual_checkout_required') {
        const challengeHint = buy.value.challengeUrl
          ? `\nDataDome-Challenge-Link: ${buy.value.challengeUrl}\nÖffne den Link im Browser, löse die Challenge und starte den Kauf danach erneut.\nFalls dort "Deine Sitzung wurde blockiert" steht, ist die aktuelle IP bei DataDome gesperrt. Deaktiviere VPN/Proxy, wechsle das Netzwerk (z. B. Mobilfunk) und versuche es später erneut.`
          : '';
        try {
          await channel.send(
            `Autokauf: Direktkauf konnte nicht finalisiert werden. Bitte schließe den Kauf manuell in Vinted ab.${challengeHint}`,
          );
        } catch (e: unknown) {
          if (isUnknownChannelError(e)) {
            await deleteSubscriptionForMissingChannel(sub);
            return;
          }
          logger.warn({ err: e, subscriptionId: sub.id }, 'Channel send failed');
          continue;
        }
        continue;
      }

      let message =
        'Autokauf: Kauf konnte nicht automatisch abgeschlossen werden. Bitte schließe den Kauf manuell in Vinted ab.';
      if (buy.value.status === 'blocked') {
        if (buy.value.challengeUrl) {
          message =
            `Autokauf: durch Vinted-Schutzmaßnahmen blockiert.\nDataDome-Challenge-Link: ${buy.value.challengeUrl}\nÖffne den Link im Browser, löse die Challenge und starte den Kauf danach erneut.\nFalls dort "Deine Sitzung wurde blockiert" steht, ist die aktuelle IP bei DataDome gesperrt. Deaktiviere VPN/Proxy, wechsle das Netzwerk (z. B. Mobilfunk) und versuche es später erneut.`;
        } else {
          message =
            'Autokauf: durch Vinted-Schutzmaßnahmen blockiert. Bitte schließe den Kauf manuell in Vinted ab.';
        }
      } else if (buy.value.status === 'access_denied') {
        message =
          'Autokauf: Vinted verweigert Checkout für dieses Konto (access_denied). Das ist meist eine Vinted-Konto/IP-Sperre für API-Aktionen; ein frischer `refresh_token_web` hilft nicht immer.';
      } else if (buy.value.status === 'invalid_pickup_point') {
        message =
          'Autokauf: gespeicherte Koordinaten sind ungültig. Setze sie mit `/set_pickup_point` neu.';
      }

      try {
        await channel.send(message);
      } catch (e: unknown) {
        if (isUnknownChannelError(e)) {
          await deleteSubscriptionForMissingChannel(sub);
          return;
        }
        logger.warn({ err: e, subscriptionId: sub.id }, 'Channel send failed');
        continue;
      }
    }
  }

  if (lastHandledItemId !== null) {
    await updateSubscriptionLastSeen({ id: sub.id, lastSeenItemId: lastHandledItemId });
  }
}



