import { err, ok } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshTokenMock = vi.fn();
const getAccountForUserMock = vi.fn();
const decryptTokenMock = vi.fn();

vi.mock('../infra/vinted/vinted-client.js', () => ({
  VintedClient: class {
    refreshToken = refreshTokenMock;
  },
}));

vi.mock('../services/vinted-account-service.js', () => ({
  getAccountForUser: getAccountForUserMock,
}));

vi.mock('../infra/crypto/token-encryption.js', () => ({
  decryptToken: decryptTokenMock,
  encryptToken: vi.fn((value: string) => value),
}));

vi.mock('../infra/db/db.js', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

vi.mock('../infra/db/schema/index.js', () => ({
  vintedAccounts: { discordUserId: 'discordUserId' },
}));

describe('vinted-token-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getAccountForUserMock.mockResolvedValue(
      ok({ region: 'de', encryptedRefreshToken: 'encrypted', pickupPoint: null }),
    );
    decryptTokenMock.mockReturnValue('refresh-token');
  });

  it('caches invalid_grant as reauth-required until cleared', async () => {
    const tokenService = await import('../services/vinted-token-service.js');

    refreshTokenMock.mockResolvedValueOnce(
      err({ message: 'Vinted request failed (401). {"error":"invalid_grant"}' }),
    );

    const first = await tokenService.getAccessTokenForUser({ discordUserId: 'u1' });
    expect(first.isErr()).toBe(true);
    if (first.isErr()) {
      expect(first.error.message).toContain('/setup account');
    }

    const second = await tokenService.getAccessTokenForUser({ discordUserId: 'u1' });
    expect(second.isErr()).toBe(true);
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);

    tokenService.clearTokenStateForUser({ discordUserId: 'u1' });

    refreshTokenMock.mockResolvedValueOnce(
      ok({ accessToken: 'access', refreshToken: 'refresh-token', expiresIn: 3600, createdAt: 10 }),
    );

    const third = await tokenService.getAccessTokenForUser({ discordUserId: 'u1' });
    expect(third.isOk()).toBe(true);
    expect(refreshTokenMock).toHaveBeenCalledTimes(2);
  });
});
