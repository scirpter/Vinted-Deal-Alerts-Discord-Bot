import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { attemptCheckoutBuild, attemptInstantBuy } from '../services/vinted-actions-service.js';

type CheckoutDeps = NonNullable<Parameters<typeof attemptCheckoutBuild>[1]>;
type InstantBuyDeps = NonNullable<Parameters<typeof attemptInstantBuy>[1]>;

function createDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
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
    getAccountForUser: () =>
      Promise.resolve(
        ok({
          region: 'de',
          encryptedRefreshToken: 'encrypted',
          pickupPoint: '52.520008,13.404954',
        }),
      ),
    parseRegion: (region: string) => ok(region as any),
    createConversationTransaction: () => Promise.resolve(ok({ transactionId: 1n })),
    buildCheckout: () => Promise.resolve(ok({ checkoutUrl: 'https://checkout.example' })),
    ...overrides,
  };
}

function createInstantBuyDeps(overrides: Partial<InstantBuyDeps> = {}): InstantBuyDeps {
  return {
    ...createDeps(),
    submitCheckoutPurchase: () => Promise.resolve(ok({ purchased: true })),
    ...overrides,
  };
}

describe('attemptCheckoutBuild', () => {
  it('returns ready when checkout build succeeds on first try', async () => {
    const deps = createDeps();

    const res = await attemptCheckoutBuild(
      {
        discordUserId: 'u1',
        itemId: 1n,
      },
      deps,
    );

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'ready', checkoutUrl: 'https://checkout.example' });
  });

  it('retries without pickup point when first response has no checkout url', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://checkout-fallback.example' }));

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 99n }, deps);

    expect(buildCheckout).toHaveBeenCalledTimes(2);
    expect(buildCheckout.mock.calls[0]?.[0].pickupPoint).toBe('52.520008,13.404954');
    expect(buildCheckout.mock.calls[1]?.[0].pickupPoint).toBeUndefined();

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'ready_without_pickup',
      checkoutUrl: 'https://checkout-fallback.example',
    });
  });

  it('retries without pickup point when pickup point is invalid', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(err({ message: 'Vinted request failed (422). pickup_point invalid.' }))
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://checkout-fallback.example' }));

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 2n }, deps);

    expect(buildCheckout).toHaveBeenCalledTimes(2);
    expect(buildCheckout.mock.calls[0]?.[0].pickupPoint).toBe('52.520008,13.404954');
    expect(buildCheckout.mock.calls[1]?.[0].pickupPoint).toBeUndefined();

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'ready_without_pickup',
      checkoutUrl: 'https://checkout-fallback.example',
    });
  });

  it('returns invalid_pickup_point when retry without pickup point still fails', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(err({ message: 'Vinted request failed (422). pickup_point invalid.' }))
      .mockResolvedValueOnce(err({ message: 'Vinted request failed (500). upstream timeout.' }));

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 3n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'invalid_pickup_point' });
  });

  it('returns blocked for anti-bot responses', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(
        err({
          message:
            'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz und versuche es spÃ¤ter erneut.',
        }),
      );

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 4n }, deps);

    expect(buildCheckout).toHaveBeenCalledTimes(1);
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'blocked' });
  });

  it('returns blocked with challenge url when checkout build reports captcha delivery url', async () => {
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=challenge-1';
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null, challengeUrl }));

    const deps = createDeps({
      buildCheckout,
      getAccountForUser: () =>
        Promise.resolve(
          ok({
            region: 'de',
            encryptedRefreshToken: 'encrypted',
            pickupPoint: null,
          }),
        ),
    });

    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 4n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'blocked',
      source: 'missing_checkout_url',
      purchaseIdCandidates: [4n],
      challengeUrl,
    });
  });

  it('does not retry without pickup when checkout build is blocked with challenge url', async () => {
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=challenge-no-fallback';
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null, challengeUrl }));

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 404n }, deps);

    expect(buildCheckout).toHaveBeenCalledTimes(1);
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'blocked',
      source: 'missing_checkout_url',
      purchaseIdCandidates: [404n],
      challengeUrl,
    });
  });

  it('returns access_denied when Vinted denies checkout API access', async () => {
    const buildCheckout = vi.fn().mockResolvedValueOnce(
      err({
        message:
          'Vinted request failed (403). {"code":106,"message":"AccÃ¨s refusÃ© ","message_code":"access_denied"}',
      }),
    );

    const deps = createDeps({ buildCheckout });
    const res = await attemptCheckoutBuild({ discordUserId: 'u1', itemId: 5n }, deps);

    expect(buildCheckout).toHaveBeenCalledTimes(1);
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'access_denied' });
  });

  it('uses resolved transaction id when seller id is available', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 777n }));
    const buildCheckout = vi.fn().mockResolvedValueOnce(ok({ checkoutUrl: 'https://checkout.example' }));

    const deps = createDeps({ createConversationTransaction, buildCheckout });
    const res = await attemptCheckoutBuild(
      { discordUserId: 'u1', itemId: 123n, sellerUserId: 456 },
      deps,
    );

    expect(createConversationTransaction).toHaveBeenCalledTimes(1);
    expect(buildCheckout).toHaveBeenCalledTimes(1);
    expect(buildCheckout.mock.calls[0]?.[0].itemId).toBe(777n);
    expect(res.isOk()).toBe(true);
  });

  it('retries checkout build with original item id when transaction checkout has no usable url', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 777n }));
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://checkout-original.example?purchase_id=7007' }));

    const deps = createDeps({ createConversationTransaction, buildCheckout });
    const res = await attemptCheckoutBuild(
      { discordUserId: 'u1', itemId: 123n, sellerUserId: 456 },
      deps,
    );

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'ready',
      checkoutUrl: 'https://checkout-original.example?purchase_id=7007',
    });

    expect(buildCheckout).toHaveBeenCalledTimes(3);
    expect(buildCheckout.mock.calls[0]?.[0].itemId).toBe(777n);
    expect(buildCheckout.mock.calls[1]?.[0].itemId).toBe(777n);
    expect(buildCheckout.mock.calls[2]?.[0].itemId).toBe(123n);
  });

  it('returns blocked with merged purchase id candidates when both checkout ids miss checkout_url', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 777n }));
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }));

    const deps = createDeps({ createConversationTransaction, buildCheckout });
    const res = await attemptCheckoutBuild(
      { discordUserId: 'u1', itemId: 123n, sellerUserId: 456 },
      deps,
    );

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.status).toBe('blocked');
    if (res.value.status !== 'blocked') return;
    expect(res.value.source).toBe('fallback_missing_checkout_url');
    expect(new Set((res.value.purchaseIdCandidates ?? []).map((candidate) => candidate.toString()))).toEqual(
      new Set(['777', '123']),
    );
  });

  it('does not retry with original item id when transaction checkout is blocked with challenge url', async () => {
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=challenge-stop-retry';
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 777n }));
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null, challengeUrl }));

    const deps = createDeps({
      createConversationTransaction,
      buildCheckout,
      getAccountForUser: () =>
        Promise.resolve(
          ok({
            region: 'de',
            encryptedRefreshToken: 'encrypted',
            pickupPoint: null,
          }),
        ),
    });
    const res = await attemptCheckoutBuild(
      { discordUserId: 'u1', itemId: 123n, sellerUserId: 456 },
      deps,
    );

    expect(buildCheckout).toHaveBeenCalledTimes(1);
    expect(buildCheckout.mock.calls[0]?.[0].itemId).toBe(777n);
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({
      status: 'blocked',
      source: 'missing_checkout_url',
      purchaseIdCandidates: [777n],
      challengeUrl,
    });
  });
});

describe('attemptInstantBuy', () => {
  it('returns purchased when checkout submit confirms success', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://www.vinted.de/checkout?purchase_id=1001' }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValueOnce(ok({ purchased: true }));
    const deps = createInstantBuyDeps({ buildCheckout, submitCheckoutPurchase });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 11n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'purchased' });
    expect(submitCheckoutPurchase).toHaveBeenCalledTimes(1);
    expect(submitCheckoutPurchase.mock.calls[0]?.[0].purchaseId).toBe(1001n);
  });

  it('returns purchased_without_pickup when fallback checkout path succeeds', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://www.vinted.de/checkout?purchase_id=1002' }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValueOnce(ok({ purchased: true }));
    const deps = createInstantBuyDeps({ buildCheckout, submitCheckoutPurchase });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 12n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'purchased_without_pickup' });
  });

  it('returns manual_checkout_required when submit does not complete purchase', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://www.vinted.de/checkout?purchase_id=1003' }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValueOnce(ok({ purchased: false }));
    const deps = createInstantBuyDeps({ buildCheckout, submitCheckoutPurchase });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 13n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'manual_checkout_required' });
  });

  it('maps submit endpoint anti-bot responses to blocked', async () => {
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://www.vinted.de/checkout?purchase_id=1004' }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValueOnce(
      err({
        message:
          'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz und versuche es später erneut.',
      }),
    );
    const deps = createInstantBuyDeps({ buildCheckout, submitCheckoutPurchase });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 14n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'blocked' });
  });

  it('propagates challenge url when submit endpoint is blocked by captcha delivery', async () => {
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=challenge-submit';
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: 'https://www.vinted.de/checkout?purchase_id=1004' }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValueOnce(
      err({
        message: `Vinted request blocked by DataDome challenge. Open this URL in your browser and retry: ${challengeUrl}`,
      }),
    );
    const deps = createInstantBuyDeps({ buildCheckout, submitCheckoutPurchase });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 15n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'blocked', challengeUrl });
  });

  it('tries direct submit fallback when checkout build has no checkout_url', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 888n }));
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }));
    const submitCheckoutPurchase = vi.fn().mockImplementation((input: { purchaseId: bigint }) => {
      if (input.purchaseId === 888n) {
        return Promise.resolve(ok({ purchased: true }));
      }
      return Promise.resolve(err({ message: 'Vinted request failed (404). No purchase found.' }));
    });

    const deps = createInstantBuyDeps({
      createConversationTransaction,
      buildCheckout,
      submitCheckoutPurchase,
    });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 12n, sellerUserId: 42 }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'purchased' });
    expect(submitCheckoutPurchase).toHaveBeenCalled();
    const attemptedPurchaseIds = new Set(
      submitCheckoutPurchase.mock.calls
        .map((call) => call[0]?.purchaseId)
        .filter((value): value is bigint => typeof value === 'bigint')
        .map((value) => value.toString()),
    );
    expect(attemptedPurchaseIds.has('888')).toBe(true);
  });

  it('maps unknown submit fallback errors to manual_checkout_required after blocked build', async () => {
    const createConversationTransaction = vi
      .fn()
      .mockResolvedValueOnce(ok({ transactionId: 999n }));
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }))
      .mockResolvedValueOnce(ok({ checkoutUrl: null }));
    const submitCheckoutPurchase = vi
      .fn()
      .mockResolvedValue(err({ message: 'Vinted request failed (404). No purchase found.' }));

    const deps = createInstantBuyDeps({
      createConversationTransaction,
      buildCheckout,
      submitCheckoutPurchase,
    });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 12n, sellerUserId: 42 }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'manual_checkout_required' });
  });

  it('does not run submit fallback when checkout build is blocked by challenge url', async () => {
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=challenge-stop-submit-fallback';
    const buildCheckout = vi
      .fn()
      .mockResolvedValueOnce(ok({ checkoutUrl: null, challengeUrl }));
    const submitCheckoutPurchase = vi.fn().mockResolvedValue(ok({ purchased: true }));

    const deps = createInstantBuyDeps({
      buildCheckout,
      submitCheckoutPurchase,
      getAccountForUser: () =>
        Promise.resolve(
          ok({
            region: 'de',
            encryptedRefreshToken: 'encrypted',
            pickupPoint: null,
          }),
        ),
    });

    const res = await attemptInstantBuy({ discordUserId: 'u1', itemId: 15n }, deps);

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ status: 'blocked', challengeUrl });
    expect(submitCheckoutPurchase).not.toHaveBeenCalled();
  });
});

