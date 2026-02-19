import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import {
  extractRefreshTokenCandidates,
  resolveRefreshTokenForSetup,
} from '../services/setup-account-refresh-token.js';

describe('setup account refresh token resolver', () => {
  it('extracts candidates from raw token and cookie style input', () => {
    const candidates = extractRefreshTokenCandidates(
      'foo=bar; refresh_token_web=abc%2Bdef%3D; Path=/; Secure',
    );

    expect(candidates).toContain('abc%2Bdef%3D');
    expect(candidates).toContain('abc+def=');
  });

  it('extracts token from set-cookie style input with whitespace/newlines', () => {
    const candidates = extractRefreshTokenCandidates(
      'Set-Cookie: refresh_token_web = abc%2Fdef%2Bghi%3D \n; Path=/; Secure',
    );

    expect(candidates).toContain('abc%2Fdef%2Bghi%3D');
    expect(candidates).toContain('abc/def+ghi=');
  });

  it('uses selected region when token is valid there', async () => {
    const refreshAttempt = vi.fn(({ region, refreshToken }: { region: string; refreshToken: string }) => {
      if (region === 'nl' && refreshToken === 'real-token') {
        return Promise.resolve(ok({
          accessToken: 'access',
          refreshToken: 'next-refresh',
          expiresIn: 3600,
          createdAt: 1,
        }));
      }
      return Promise.resolve(err({ message: 'Vinted request failed (401). {"error":"invalid_grant"}' }));
    });

    const res = await resolveRefreshTokenForSetup({
      selectedRegion: 'nl',
      refreshTokenInput: 'refresh_token_web=real-token',
      refreshAttempt,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.region).toBe('nl');
    expect(res.value.tokenResponse.refreshToken).toBe('next-refresh');
  });

  it('falls back to other regions on invalid_grant', async () => {
    const refreshAttempt = vi.fn(({ region }: { region: string; refreshToken: string }) => {
      if (region === 'de') {
        return Promise.resolve(ok({
          accessToken: 'access',
          refreshToken: 'de-refresh',
          expiresIn: 3600,
          createdAt: 1,
        }));
      }
      return Promise.resolve(err({ message: 'Vinted request failed (401). {"error":"invalid_grant"}' }));
    });

    const res = await resolveRefreshTokenForSetup({
      selectedRegion: 'nl',
      refreshTokenInput: 'real-token',
      refreshAttempt,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.region).toBe('de');
  });

  it('returns clear invalid_grant message when all regions fail', async () => {
    const refreshAttempt = vi.fn(() =>
      Promise.resolve(err({ message: 'Vinted request failed (401). {"error":"invalid_grant"}' })),
    );

    const res = await resolveRefreshTokenForSetup({
      selectedRegion: 'nl',
      refreshTokenInput: 'real-token',
      refreshAttempt,
    });

    expect(res.isErr()).toBe(true);
    if (res.isOk()) return;
    expect(res.error.message).toContain('invalid_grant');
    expect(res.error.message).toContain('refresh_token_web');
  });

  it('returns blocked errors immediately', async () => {
    const refreshAttempt = vi.fn(() =>
      Promise.resolve(err({ message: 'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare).' })),
    );

    const res = await resolveRefreshTokenForSetup({
      selectedRegion: 'nl',
      refreshTokenInput: 'real-token',
      refreshAttempt,
    });

    expect(res.isErr()).toBe(true);
    if (res.isOk()) return;
    expect(res.error.message).toContain('blockiert');
  });
});
