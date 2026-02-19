import { eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { encryptToken } from '../infra/crypto/token-encryption.js';
import { db } from '../infra/db/db.js';
import { discordUsers, vintedAccounts } from '../infra/db/schema/index.js';
import { parseRegion } from '../infra/vinted/regions.js';
import { VintedClient } from '../infra/vinted/vinted-client.js';
import { validatePickupPoint } from './pickup-point-validation.js';
import { resolveRefreshTokenForSetup } from './setup-account-refresh-token.js';

const vinted = new VintedClient();

export async function ensureAccountConfigured(input: {
  discordUserId: string;
}): Promise<Result<true, Error>> {
  const row = await db.query.vintedAccounts.findFirst({
    where: (t, { eq }) => eq(t.discordUserId, input.discordUserId),
  });
  if (!row) {
    return err(new Error('Kein Vinted-Konto eingerichtet. Führe zuerst /setup account aus.'));
  }
  return ok(true);
}

export async function upsertAccountFromRefreshToken(input: {
  discordUserId: string;
  region: string;
  refreshToken: string;
}): Promise<Result<true, Error>> {
  const regionRes = parseRegion(input.region);
  if (regionRes.isErr()) return err(regionRes.error);

  const tokenCheck = await resolveRefreshTokenForSetup({
    selectedRegion: regionRes.value,
    refreshTokenInput: input.refreshToken,
    refreshAttempt: (attempt) => vinted.refreshToken({ ...attempt, sessionKey: input.discordUserId }),
  });
  if (tokenCheck.isErr()) {
    return err(tokenCheck.error);
  }

  const encrypted = encryptToken(tokenCheck.value.tokenResponse.refreshToken);

  await db.insert(discordUsers).values({ discordUserId: input.discordUserId }).onDuplicateKeyUpdate({
    set: { discordUserId: input.discordUserId },
  });

  await db
    .insert(vintedAccounts)
    .values({
      discordUserId: input.discordUserId,
      region: tokenCheck.value.region,
      encryptedRefreshToken: encrypted,
    })
    .onDuplicateKeyUpdate({
      set: { region: tokenCheck.value.region, encryptedRefreshToken: encrypted },
    });

  return ok(true);
}

export async function upsertPickupPoint(input: {
  discordUserId: string;
  pickupPoint: string;
}): Promise<Result<true, Error>> {
  const existing = await db.query.vintedAccounts.findFirst({
    where: (t, { eq }) => eq(t.discordUserId, input.discordUserId),
  });
  if (!existing) {
    return err(new Error('Kein Vinted-Konto eingerichtet. Führe zuerst /setup account aus.'));
  }

  const validatedPickupPoint = validatePickupPoint(input.pickupPoint);
  if (validatedPickupPoint.isErr()) return err(validatedPickupPoint.error);

  await db
    .update(vintedAccounts)
    .set({ pickupPoint: validatedPickupPoint.value })
    .where(eq(vintedAccounts.discordUserId, input.discordUserId));

  return ok(true);
}

export async function getAccountForUser(input: {
  discordUserId: string;
}): Promise<
  Result<
    { region: string; encryptedRefreshToken: string; pickupPoint: string | null },
    Error
  >
> {
  const row = await db.query.vintedAccounts.findFirst({
    where: (t, { eq }) => eq(t.discordUserId, input.discordUserId),
  });
  if (!row) return err(new Error('Kein Vinted-Konto eingerichtet. Führe zuerst /setup account aus.'));
  return ok({
    region: row.region,
    encryptedRefreshToken: row.encryptedRefreshToken,
    pickupPoint: row.pickupPoint ?? null,
  });
}
