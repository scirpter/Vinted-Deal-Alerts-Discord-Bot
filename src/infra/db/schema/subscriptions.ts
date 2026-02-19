import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  datetime,
  index,
  int,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import { discordUsers } from './discord-users.js';

export const subscriptions = mysqlTable(
  'subscriptions',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    discordGuildId: varchar('discord_guild_id', { length: 32 }).notNull(),
    discordUserId: varchar('discord_user_id', { length: 32 })
      .notNull()
      .references(() => discordUsers.discordUserId, { onDelete: 'cascade' }),
    discordChannelId: varchar('discord_channel_id', { length: 32 }).notNull(),
    label: varchar('label', { length: 100 }).notNull(),
    searchUrl: text('search_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    autobuyEnabled: boolean('autobuy_enabled').notNull().default(false),
    lastSeenItemId: bigint('last_seen_item_id', { mode: 'bigint', unsigned: true }),
    includeKeywords: text('include_keywords'),
    excludeKeywords: text('exclude_keywords'),
    priceMinCents: int('price_min_cents', { unsigned: true }),
    priceMaxCents: int('price_max_cents', { unsigned: true }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => ({
    guildIdx: index('subscriptions_guild_idx').on(t.discordGuildId),
    userIdx: index('subscriptions_user_idx').on(t.discordUserId),
  }),
);
