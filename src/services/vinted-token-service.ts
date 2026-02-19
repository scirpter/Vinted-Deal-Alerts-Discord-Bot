import { eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { decryptToken, encryptToken } from '../infra/crypto/token-encryption.js';
import { db } from '../infra/db/db.js';
import { vintedAccounts } from '../infra/db/schema/index.js';
import { parseRegion, type VintedRegion } from '../infra/vinted/regions.js';
import { VintedClient } from '../infra/vinted/vinted-client.js';
import { getAccountForUser } from './vinted-account-service.js';

type CachedToken = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  region: VintedRegion;
};

type BlockState = { until: number; strikes: number };
type ReauthState = { until: number };

const cache = new Map<string, CachedToken>();
const blocked = new Map<string, BlockState>();
const reauthRequired = new Map<string, ReauthState>();
const inFlight = new Map<string, Promise<Result<CachedToken, Error>>>();
const vinted = new VintedClient();
const REAUTH_COOLDOWN_MS = 30 * 60 * 1000;

function isBlockedError(message: string): boolean {
  return message.toLowerCase().includes('blockiert');
}

function isInvalidGrantError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid_grant') || lower.includes('authorization grant is invalid');
}

function reauthRequiredError(): Error {
  return new Error(
    'Vinted-Token ist ungültig oder abgelaufen. Führe /setup account mit einem frischen refresh_token_web erneut aus.',
  );
}

function bumpBackoff(prev: BlockState | undefined): BlockState {
  const strikes = Math.min((prev?.strikes ?? 0) + 1, 6);
  const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** strikes);
  return { strikes, until: Date.now() + delayMs };
}

export function clearTokenStateForUser(input: { discordUserId: string }): void {
  cache.delete(input.discordUserId);
  blocked.delete(input.discordUserId);
  reauthRequired.delete(input.discordUserId);
  inFlight.delete(input.discordUserId);
}

export async function getAccessTokenForUser(input: {
  discordUserId: string;
}): Promise<Result<CachedToken, Error>> {
  const cached = cache.get(input.discordUserId);
  if (cached && Date.now() < cached.expiresAtMs - 30_000) {
    return ok(cached);
  }

  const block = blocked.get(input.discordUserId);
  if (block && Date.now() < block.until) {
    return err(
      new Error(
        'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz und versuche es später erneut.',
      ),
    );
  }

  const reauth = reauthRequired.get(input.discordUserId);
  if (reauth && Date.now() < reauth.until) {
    return err(reauthRequiredError());
  }

  const existing = inFlight.get(input.discordUserId);
  if (existing) return existing;

  const promise = (async (): Promise<Result<CachedToken, Error>> => {
    const account = await getAccountForUser({ discordUserId: input.discordUserId });
    if (account.isErr()) return err(account.error);

    const regionRes = parseRegion(account.value.region);
    if (regionRes.isErr()) return err(regionRes.error);

    let refreshToken: string;
    try {
      refreshToken = decryptToken(account.value.encryptedRefreshToken);
    } catch {
      return err(
        new Error(
          'Gespeicherter Refresh-Token konnte nicht entschlüsselt werden. Führe /setup account erneut aus.',
        ),
      );
    }

    const refreshed = await vinted.refreshToken({
      region: regionRes.value,
      refreshToken,
      sessionKey: input.discordUserId,
    });
    if (refreshed.isErr()) {
      if (isBlockedError(refreshed.error.message)) {
        blocked.set(input.discordUserId, bumpBackoff(blocked.get(input.discordUserId)));
        return err(new Error(refreshed.error.message));
      }
      if (isInvalidGrantError(refreshed.error.message)) {
        reauthRequired.set(input.discordUserId, { until: Date.now() + REAUTH_COOLDOWN_MS });
        cache.delete(input.discordUserId);
        blocked.delete(input.discordUserId);
        return err(reauthRequiredError());
      }
      return err(new Error('Vinted-Token konnte nicht erneuert werden. Führe /setup account erneut aus.'));
    }

    const expiresAtMs = (refreshed.value.createdAt + refreshed.value.expiresIn) * 1000;

    const next: CachedToken = {
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
      expiresAtMs,
      region: regionRes.value,
    };

    cache.set(input.discordUserId, next);

    if (refreshed.value.refreshToken !== refreshToken) {
      await db
        .update(vintedAccounts)
        .set({ encryptedRefreshToken: encryptToken(refreshed.value.refreshToken) })
        .where(eq(vintedAccounts.discordUserId, input.discordUserId));
    }

    blocked.delete(input.discordUserId);
    reauthRequired.delete(input.discordUserId);
    return ok(next);
  })();

  inFlight.set(input.discordUserId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(input.discordUserId);
  }
}
