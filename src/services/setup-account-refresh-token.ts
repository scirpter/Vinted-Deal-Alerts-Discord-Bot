import { err, ok, type Result } from 'neverthrow';
import type { VintedTokenResponse } from '../infra/vinted/vinted-client.js';
import type { VintedRegion } from '../infra/vinted/regions.js';

const ALL_REGIONS: readonly VintedRegion[] = ['de', 'at', 'fr', 'it', 'es', 'nl', 'pl', 'cz', 'pt'];

const INVALID_GRANT_SETUP_MESSAGE =
  'Refresh-Token konnte nicht verifiziert werden (invalid_grant). Bitte füge den Cookie-Wert `refresh_token_web` von `www.vinted.<region>` ein (nicht den kompletten Cookie-Header) und melde dich auf der gewählten Region ggf. neu an. Wenn derselbe Vinted-Account parallel in einem anderen Bot läuft, stoppe ihn vorübergehend: Refresh-Token können bei Rotation den alten Token ungültig machen.';

function isInvalidGrantError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid_grant') || lower.includes('authorization grant is invalid');
}

function isBlockedError(message: string): boolean {
  return message.toLowerCase().includes('blockiert');
}

function sanitizeRawTokenCandidate(value: string): string {
  let next = value.trim();
  if (next.toLowerCase().startsWith('set-cookie:')) {
    next = next.slice('set-cookie:'.length).trim();
  }
  if (next.toLowerCase().startsWith('cookie:')) {
    next = next.slice('cookie:'.length).trim();
  }
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  if (next.startsWith('`') && next.endsWith('`')) {
    next = next.slice(1, -1).trim();
  }
  if (next.toLowerCase().startsWith('bearer ')) {
    next = next.slice('bearer '.length).trim();
  }
  if (next.toLowerCase().startsWith('refresh_token_web:')) {
    next = next.slice('refresh_token_web:'.length).trim();
  }
  next = next.replace(/\\(["'])/g, '$1');
  next = next.replace(/\s+/g, '');
  if (next.toLowerCase().startsWith('refresh_token_web=')) {
    next = next.slice('refresh_token_web='.length).trim();
  }
  return next;
}

function tryDecodeURIComponent(value: string): string | null {
  if (!value.includes('%')) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseCookieValue(raw: string, name: string): string | null {
  const lowerName = name.toLowerCase();
  for (const part of raw.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = segment.slice(0, eqIndex).trim().toLowerCase();
    if (key !== lowerName) continue;
    return segment.slice(eqIndex + 1).trim();
  }
  return null;
}

function parseJsonLikeValue(raw: string): string | null {
  const match = raw.match(/refresh_token_web"\s*:\s*"([^"]+)"/i);
  return match?.[1]?.trim() || null;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

export function extractRefreshTokenCandidates(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const candidates: string[] = [];
  const pushCandidate = (value: string | null | undefined) => {
    if (!value) return;
    const sanitized = sanitizeRawTokenCandidate(value);
    if (!sanitized) return;
    candidates.push(sanitized);
    const decoded = tryDecodeURIComponent(sanitized);
    if (decoded && decoded !== sanitized) {
      candidates.push(decoded);
    }
  };

  pushCandidate(raw);
  pushCandidate(parseCookieValue(raw, 'refresh_token_web'));
  pushCandidate(parseJsonLikeValue(raw));

  const regexMatch = raw.match(/refresh_token_web\s*=\s*([^;\s]+)/i);
  pushCandidate(regexMatch?.[1] ?? null);

  return uniqueStrings(candidates);
}

export async function resolveRefreshTokenForSetup(input: {
  selectedRegion: VintedRegion;
  refreshTokenInput: string;
  refreshAttempt: (args: {
    region: VintedRegion;
    refreshToken: string;
  }) => Promise<Result<VintedTokenResponse, { message: string }>>;
}): Promise<Result<{ region: VintedRegion; tokenResponse: VintedTokenResponse }, Error>> {
  const tokenCandidates = extractRefreshTokenCandidates(input.refreshTokenInput);
  if (tokenCandidates.length === 0) {
    return err(new Error('Refresh-Token darf nicht leer sein.'));
  }

  const regions: VintedRegion[] = [
    input.selectedRegion,
    ...ALL_REGIONS.filter((region) => region !== input.selectedRegion),
  ];

  let sawInvalidGrant = false;

  for (const region of regions) {
    for (const refreshToken of tokenCandidates) {
      const refreshed = await input.refreshAttempt({ region, refreshToken });
      if (refreshed.isOk()) {
        return ok({ region, tokenResponse: refreshed.value });
      }

      const message = refreshed.error.message;
      if (isBlockedError(message)) {
        return err(new Error(message));
      }
      if (isInvalidGrantError(message)) {
        sawInvalidGrant = true;
        continue;
      }

      return err(new Error(message));
    }
  }

  if (sawInvalidGrant) {
    return err(new Error(INVALID_GRANT_SETUP_MESSAGE));
  }

  return err(new Error('Refresh-Token konnte nicht verifiziert werden. Bitte prüfe ihn und versuche es erneut.'));
}
