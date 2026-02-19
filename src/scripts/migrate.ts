import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { env } from '../env.js';
import { logger } from '../logger.js';

const connection = await mysql.createConnection(env.DATABASE_URL);
const db = drizzle(connection);

await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle/migrations') });
await connection.end();

logger.info('Migrations applied');

