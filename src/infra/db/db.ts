import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { env } from '../../env.js';
import * as schema from './schema/index.js';

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  enableKeepAlive: true,
  namedPlaceholders: true,
});

export const db = drizzle(pool, { schema, mode: 'default' });
