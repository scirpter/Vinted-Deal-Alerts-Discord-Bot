import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { subscriptions } from './subscriptions.js';

export const postedItems = mysqlTable(
  'posted_items',
  {
    id: varchar('id', { length: 26 }).primaryKey(),
    subscriptionId: varchar('subscription_id', { length: 26 })
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    vintedItemId: bigint('vinted_item_id', { mode: 'bigint', unsigned: true }).notNull(),
    discordMessageId: varchar('discord_message_id', { length: 32 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => ({
    subItemUniq: uniqueIndex('posted_items_subscription_item_uniq').on(
      t.subscriptionId,
      t.vintedItemId,
    ),
  }),
);

