import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { attemptMakeOffer } from '../services/vinted-actions-service.js';

type OfferDeps = NonNullable<Parameters<typeof attemptMakeOffer>[1]>;

function createDeps(overrides: Partial<OfferDeps> = {}): OfferDeps {
  return {
    getAccessTokenForUser: () =>
      Promise.resolve(
        ok({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAtMs: Date.now() + 60_000,
          region: 'de',
        }),
      ),
    createConversationTransaction: () => Promise.resolve(ok({ transactionId: 1n })),
    sendOffer: () => Promise.resolve(ok({ sent: true })),
    estimateOfferWithFees: () =>
      Promise.resolve(
        ok({
          total: '10.99',
          serviceFee: '0.99',
        }),
      ),
    ...overrides,
  };
}

describe('attemptMakeOffer', () => {
  it('returns sent=true when offer API succeeds', async () => {
    const sendOffer = vi.fn().mockResolvedValueOnce(ok({ sent: true }));
    const estimateOfferWithFees = vi.fn();

    const deps = createDeps({ sendOffer, estimateOfferWithFees });
    const res = await attemptMakeOffer({ discordUserId: 'u1', itemId: 1n, amount: 8.5 }, deps);

    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(estimateOfferWithFees).not.toHaveBeenCalled();
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ sent: true });
  });

  it('returns access_denied with estimate when offer is denied', async () => {
    const sendOffer = vi
      .fn()
      .mockResolvedValueOnce(
        err({
          message:
            'Vinted request failed (403). {"code":106,"message":"Accès refusé ","message_code":"access_denied"}',
        }),
      );
    const estimateOfferWithFees = vi.fn().mockResolvedValueOnce(
      ok({
        total: '11.99',
        serviceFee: '1.49',
      }),
    );

    const deps = createDeps({ sendOffer, estimateOfferWithFees });
    const res = await attemptMakeOffer({ discordUserId: 'u1', itemId: 2n, amount: 10.5 }, deps);

    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(estimateOfferWithFees).toHaveBeenCalledTimes(1);
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      sent: false,
      status: 'access_denied',
      estimate: { total: '11.99', serviceFee: '1.49' },
    });
  });

  it('returns blocked when Vinted protection blocks offer', async () => {
    const sendOffer = vi
      .fn()
      .mockResolvedValueOnce(
        err({
          message:
            'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz und versuche es später erneut.',
        }),
      );
    const estimateOfferWithFees = vi
      .fn()
      .mockResolvedValueOnce(err({ message: 'Vinted request failed (403). challenge page' }));

    const deps = createDeps({ sendOffer, estimateOfferWithFees });
    const res = await attemptMakeOffer({ discordUserId: 'u1', itemId: 3n, amount: 12.0 }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ sent: false, status: 'blocked' });
  });

  it('uses resolved transaction id when seller id is available', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 888n }));
    const sendOffer = vi.fn().mockResolvedValueOnce(ok({ sent: true }));

    const deps = createDeps({ createConversationTransaction, sendOffer });
    const res = await attemptMakeOffer(
      { discordUserId: 'u1', itemId: 12n, sellerUserId: 42, amount: 9.9 },
      deps,
    );

    expect(createConversationTransaction).toHaveBeenCalledTimes(1);
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(sendOffer.mock.calls[0]?.[0].itemId).toBe(888n);
    expect(res.isOk()).toBe(true);
  });
});
