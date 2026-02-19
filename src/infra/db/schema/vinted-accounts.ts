import { sql } from 'drizzle-orm';
import { datetime, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { discordUsers } from './discord-users.js';

export const vintedAccounts = mysqlTable('vinted_accounts', {
  discordUserId: varchar('discord_user_id', { length: 32 })
    .primaryKey()
    .references(() => discordUsers.discordUserId, { onDelete: 'cascade' }),
  region: varchar('region', { length: 8 }).notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  pickupPoint: varchar('pickup_point', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
});

