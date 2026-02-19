import { and, desc, eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { db } from '../infra/db/db.js';
import { discordUsers, subscriptions } from '../infra/db/schema/index.js';

export type Subscription = {
  id: string;
  discordGuildId: string;
  discordUserId: string;
  discordChannelId: string;
  label: string;
  searchUrl: string;
  enabled: boolean;
  autobuyEnabled: boolean;
  lastSeenItemId: bigint | null;
  includeKeywords: string | null;
  excludeKeywords: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
};

export async function createSubscription(input: {
  id: string;
  discordGuildId: string;
  discordUserId: string;
  discordChannelId: string;
  label: string;
  searchUrl: string;
  autobuyEnabled: boolean;
  includeKeywords?: string | null;
  excludeKeywords?: string | null;
  priceMinCents?: number | null;
  priceMaxCents?: number | null;
}): Promise<Result<true, Error>> {
  await db.insert(discordUsers).values({ discordUserId: input.discordUserId }).onDuplicateKeyUpdate({
    set: { discordUserId: input.discordUserId },
  });

  await db.insert(subscriptions).values({
    id: input.id,
    discordGuildId: input.discordGuildId,
    discordUserId: input.discordUserId,
    discordChannelId: input.discordChannelId,
    label: input.label,
    searchUrl: input.searchUrl,
    enabled: true,
    autobuyEnabled: input.autobuyEnabled,
    lastSeenItemId: null,
    includeKeywords: input.includeKeywords ?? null,
    excludeKeywords: input.excludeKeywords ?? null,
    priceMinCents: input.priceMinCents ?? null,
    priceMaxCents: input.priceMaxCents ?? null,
  });
  return ok(true);
}

export async function listSubscriptions(input: {
  discordGuildId: string;
  discordUserId: string;
}): Promise<Result<Subscription[], Error>> {
  const rows = await db.query.subscriptions.findMany({
    where: (t, { and, eq }) =>
      and(eq(t.discordGuildId, input.discordGuildId), eq(t.discordUserId, input.discordUserId)),
    orderBy: (t, { asc }) => asc(t.createdAt),
  });

  return ok(
    rows.map((r) => ({
      id: r.id,
      discordGuildId: r.discordGuildId,
      discordUserId: r.discordUserId,
      discordChannelId: r.discordChannelId,
      label: r.label,
      searchUrl: r.searchUrl,
      enabled: r.enabled,
      autobuyEnabled: r.autobuyEnabled,
      lastSeenItemId: r.lastSeenItemId ?? null,
      includeKeywords: r.includeKeywords ?? null,
      excludeKeywords: r.excludeKeywords ?? null,
      priceMinCents: r.priceMinCents ?? null,
      priceMaxCents: r.priceMaxCents ?? null,
    })),
  );
}

export async function getSubscriptionById(input: {
  id: string;
  discordGuildId: string;
  discordUserId: string;
}): Promise<Result<Subscription, Error>> {
  const row = await db.query.subscriptions.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, input.id), eq(t.discordGuildId, input.discordGuildId)),
  });
  if (!row) return err(new Error('Abo nicht gefunden.'));
  if (row.discordUserId !== input.discordUserId) {
    return err(new Error('Du hast keinen Zugriff auf dieses Abo.'));
  }
  return ok({
    id: row.id,
    discordGuildId: row.discordGuildId,
    discordUserId: row.discordUserId,
    discordChannelId: row.discordChannelId,
    label: row.label,
    searchUrl: row.searchUrl,
    enabled: row.enabled,
    autobuyEnabled: row.autobuyEnabled,
    lastSeenItemId: row.lastSeenItemId ?? null,
    includeKeywords: row.includeKeywords ?? null,
    excludeKeywords: row.excludeKeywords ?? null,
    priceMinCents: row.priceMinCents ?? null,
    priceMaxCents: row.priceMaxCents ?? null,
  });
}

export async function deleteSubscription(input: {
  id: string;
  discordGuildId: string;
  discordUserId: string;
}): Promise<Result<true, Error>> {
  const sub = await getSubscriptionById(input);
  if (sub.isErr()) return err(sub.error);

  await db
    .delete(subscriptions)
    .where(
      and(
        eq(subscriptions.id, input.id),
        eq(subscriptions.discordGuildId, input.discordGuildId),
        eq(subscriptions.discordUserId, input.discordUserId),
      ),
    );
  return ok(true);
}

export async function listAllEnabledSubscriptions(): Promise<Subscription[]> {
  const rows = await db.query.subscriptions.findMany({
    where: (t, { eq }) => eq(t.enabled, true),
    orderBy: (t) => [desc(t.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    discordGuildId: r.discordGuildId,
    discordUserId: r.discordUserId,
    discordChannelId: r.discordChannelId,
    label: r.label,
    searchUrl: r.searchUrl,
    enabled: r.enabled,
    autobuyEnabled: r.autobuyEnabled,
    lastSeenItemId: r.lastSeenItemId ?? null,
    includeKeywords: r.includeKeywords ?? null,
    excludeKeywords: r.excludeKeywords ?? null,
    priceMinCents: r.priceMinCents ?? null,
    priceMaxCents: r.priceMaxCents ?? null,
  }));
}

export async function updateSubscriptionLastSeen(input: {
  id: string;
  lastSeenItemId: bigint;
}): Promise<void> {
  await db
    .update(subscriptions)
    .set({ lastSeenItemId: input.lastSeenItemId })
    .where(eq(subscriptions.id, input.id));
}

export async function updateSubscriptionFilters(input: {
  id: string;
  discordGuildId: string;
  discordUserId: string;
  includeKeywords?: string | null;
  excludeKeywords?: string | null;
  priceMinCents?: number | null;
  priceMaxCents?: number | null;
}): Promise<Result<true, Error>> {
  const sub = await getSubscriptionById(input);
  if (sub.isErr()) return err(sub.error);

  const patch: Partial<{
    includeKeywords: string | null;
    excludeKeywords: string | null;
    priceMinCents: number | null;
    priceMaxCents: number | null;
  }> = {};

  if (input.includeKeywords !== undefined) patch.includeKeywords = input.includeKeywords;
  if (input.excludeKeywords !== undefined) patch.excludeKeywords = input.excludeKeywords;
  if (input.priceMinCents !== undefined) patch.priceMinCents = input.priceMinCents;
  if (input.priceMaxCents !== undefined) patch.priceMaxCents = input.priceMaxCents;

  await db.update(subscriptions).set(patch).where(eq(subscriptions.id, input.id));
  return ok(true);
}
