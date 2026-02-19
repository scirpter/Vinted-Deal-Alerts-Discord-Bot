import 'dotenv/config';
import { z } from 'zod';

function intFromEnv(
  defaultValue: number,
  input: { min: number; max?: number } = { min: Number.MIN_SAFE_INTEGER },
) {
  let schema = z.number().int().min(input.min);
  if (input.max !== undefined) schema = schema.max(input.max);
  return z
    .preprocess((value) => (value === undefined || value === '' ? undefined : Number(value)), schema)
    .default(defaultValue);
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  WATCH_INTERVAL_MS: intFromEnv(5_000, { min: 5_000, max: 10 * 60_000 }),
  WATCH_CONCURRENCY: intFromEnv(1, { min: 1, max: 10 }),
  WATCH_FETCH_DELAY_MS: intFromEnv(1_000, { min: 0, max: 60_000 }),
});

export const env = envSchema.parse(process.env);
