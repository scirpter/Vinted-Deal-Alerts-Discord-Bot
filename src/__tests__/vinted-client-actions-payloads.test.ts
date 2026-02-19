import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetVintedClientRequestStateForTests,
  VintedClient,
} from '../infra/vinted/vinted-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetVintedClientRequestStateForTests();
  delete process.env.VINTED_HTTP_BACKEND;
  delete process.env.VINTED_INCOGNIA_REQUEST_TOKEN;
  delete process.env.VINTED_ANON_ID;
  delete process.env.VINTED_COOKIE;
  delete process.env.VINTED_EXTRA_HEADERS_JSON;
});

describe('VintedClient action request compatibility', () => {
  it('sends favourite toggle request using web payload shape', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { item: { is_favourite: true } }));

    const res = await new VintedClient().toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 8140069581n,
    });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const rawBody = request?.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse((rawBody as string) ?? '{}');
    expect(body).toEqual({
      type: 'item',
      user_favourites: [8140069581],
    });
  });

  it('builds checkout url from checkout id when checkout_url is missing', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { checkout: { id: 99887766 } }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 8140069581n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;

    expect(res.value.checkoutUrl).toBe(
      'https://www.vinted.nl/checkout?purchase_id=99887766&order_id=8140069581&order_type=transaction',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const rawBody = request?.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse((rawBody as string) ?? '{}');
    expect(body).toEqual({
      purchase_items: [{ id: 8140069581, type: 'transaction' }],
    });
  });

  it('keeps supporting direct checkout_url responses', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { checkout_url: 'https://www.vinted.nl/checkout?purchase_id=1' }),
    );

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 123n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBe('https://www.vinted.nl/checkout?purchase_id=1');
  });

  it('builds checkout url from nested checkout purchase id payloads', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { checkout: { purchase: { id: '11223344' } } }),
    );

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 7001n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBe(
      'https://www.vinted.nl/checkout?purchase_id=11223344&order_id=7001&order_type=transaction',
    );
  });

  it('uses nested next_step url when checkout endpoint returns relative checkout link', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        checkout: { state: 'pending' },
        next_step: { url: '/checkout?purchase_id=778899' },
      }),
    );

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 7002n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBe('https://www.vinted.nl/checkout?purchase_id=778899');
  });

  it('treats errors payload as request failure', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        status: 403,
        errors: [{ code: 106, message: 'Accès refusé', message_code: 'access_denied' }],
      }),
    );

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 123n,
      pickupPoint: null,
    });

    expect(res.isErr()).toBe(true);
    if (res.isOk()) return;
    expect(res.error.message).toContain('(403)');
    expect(res.error.message).toContain('access_denied');
  });

  it('treats top-level code/message/message_code as request failure', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        code: 106,
        message: 'Accès refusé',
        message_code: 'access_denied',
      }),
    );

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'token',
      itemId: 123n,
      pickupPoint: null,
    });

    expect(res.isErr()).toBe(true);
    if (res.isOk()) return;
    expect(res.error.message).toContain('access_denied');
  });

  it('injects optional security headers from env', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    process.env.VINTED_INCOGNIA_REQUEST_TOKEN = 'icg-token';
    process.env.VINTED_ANON_ID = 'anon-123';
    process.env.VINTED_COOKIE = 'datadome=abc; anon_id=anon-123';
    process.env.VINTED_EXTRA_HEADERS_JSON = '{"x-custom-test":"yes"}';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { item: { is_favourite: true } }));

    const res = await new VintedClient().toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 9n,
    });

    expect(res.isOk()).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = (request.headers ?? {}) as Record<string, string>;
    expect(headers['x-incognia-request-token']).toBe('icg-token');
    expect(headers['x-anon-id']).toBe('anon-123');
    expect(headers['x-datadome-clientid']).toBe('abc');
    expect(headers['x-csrf-token']).toBe('75f6c9fa-dc8e-4e52-a000-e09dd4084b3e');
    expect(headers.cookie).toContain('datadome=abc');
    expect(headers['x-custom-test']).toBe('yes');
  });

  it('applies default csrf token and derives anon id from cookie header', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    process.env.VINTED_COOKIE = 'datadome=abc; anon_id=anon-from-cookie';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { item: { is_favourite: true } }));

    const res = await new VintedClient().toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 10n,
    });

    expect(res.isOk()).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = (request.headers ?? {}) as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('75f6c9fa-dc8e-4e52-a000-e09dd4084b3e');
    expect(headers['x-anon-id']).toBe('anon-from-cookie');
  });

  it('captures set-cookie headers and reuses cookies in later requests', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';

    const tokenResponse = new Response(
      JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        created_at: 1,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'anon_id=anon-captured; Path=/; HttpOnly',
        },
      },
    );

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(jsonResponse(200, { item: { is_favourite: true } }));

    const client = new VintedClient();
    const refreshed = await client.refreshToken({
      region: 'nl',
      refreshToken: 'refresh-token',
    });
    expect(refreshed.isOk()).toBe(true);

    const favourite = await client.toggleFavourite({
      region: 'nl',
      accessToken: 'access',
      itemId: 11n,
    });

    expect(favourite.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = (secondRequest.headers ?? {}) as Record<string, string>;
    expect(headers.cookie).toContain('anon_id=anon-captured');
    expect(headers['x-anon-id']).toBe('anon-captured');
  });

  it('returns unknown favourite state when api omits explicit state', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { success: true }));

    const res = await new VintedClient().toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 12n,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ liked: false, known: false });
  });

  it('keeps session cookies isolated per session key', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';

    const withCookie = (cookie: string) =>
      new Response(JSON.stringify({ item: { is_favourite: true } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': cookie,
        },
      });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(withCookie('anon_id=anon-a; Path=/'))
      .mockResolvedValueOnce(withCookie('anon_id=anon-b; Path=/'))
      .mockResolvedValueOnce(jsonResponse(200, { item: { is_favourite: true } }))
      .mockResolvedValueOnce(jsonResponse(200, { item: { is_favourite: true } }));

    const client = new VintedClient();

    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token-a',
      itemId: 21n,
      sessionKey: 'user-a',
    });
    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token-b',
      itemId: 22n,
      sessionKey: 'user-b',
    });
    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token-a',
      itemId: 23n,
      sessionKey: 'user-a',
    });
    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token-b',
      itemId: 24n,
      sessionKey: 'user-b',
    });

    const thirdRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const thirdHeaders = (thirdRequest.headers ?? {}) as Record<string, string>;
    expect(thirdHeaders.cookie).toContain('anon_id=anon-a');
    expect(thirdHeaders['x-anon-id']).toBe('anon-a');

    const fourthRequest = fetchMock.mock.calls[3]?.[1] as RequestInit;
    const fourthHeaders = (fourthRequest.headers ?? {}) as Record<string, string>;
    expect(fourthHeaders.cookie).toContain('anon_id=anon-b');
    expect(fourthHeaders['x-anon-id']).toBe('anon-b');
  });

  it('adds x-v-udt header from captured session cookie', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: { is_favourite: true } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'v_udt=vudt-123; Path=/',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { item: { is_favourite: true } }));

    const client = new VintedClient();
    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 30n,
      sessionKey: 'user-vudt',
    });
    await client.toggleFavourite({
      region: 'nl',
      accessToken: 'token',
      itemId: 31n,
      sessionKey: 'user-vudt',
    });

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondHeaders = (secondRequest.headers ?? {}) as Record<string, string>;
    expect(secondHeaders.cookie).toContain('v_udt=vudt-123');
    expect(secondHeaders['x-v-udt']).toBe('vudt-123');
  });

  it('sends web session cookies and browser-like priority for action requests', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { checkout: { id: 44 } }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 44n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = (request.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toContain('access_token_web=access-token');
    expect(headers.cookie).toContain('refresh_token_web=refresh-token');
    expect(headers.priority).toBe('u=3');
  });

  it('retries action request with authorization when cookie-only attempt is rejected', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(200, { checkout: { id: 45 } }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 45n,
      pickupPoint: null,
    });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.authorization).toBeUndefined();
    expect(secondHeaders.authorization).toBe('Bearer access-token');
  });

  it('primes captcha challenge session and retries checkout build once', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=test123';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(403, { url: challengeUrl }))
      .mockResolvedValueOnce(
        new Response('<html>challenge</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'datadome=dd-cookie; Domain=.vinted.nl; Path=/',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { checkout: { id: 77 } }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 77n,
      pickupPoint: null,
      sessionKey: 'user-77',
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBe(
      'https://www.vinted.nl/checkout?purchase_id=77&order_id=77&order_type=transaction',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(challengeUrl);

    const retryRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const retryHeaders = (retryRequest.headers ?? {}) as Record<string, string>;
    expect(retryHeaders.cookie).toContain('datadome=dd-cookie');
    expect(retryHeaders['x-datadome-clientid']).toBe('dd-cookie');
  });

  it('returns challenge url when checkout remains blocked by captcha delivery', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=test-persist';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(403, { url: challengeUrl }))
      .mockResolvedValueOnce(
        new Response('<html>challenge</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(403, { url: challengeUrl }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 88n,
      pickupPoint: null,
      sessionKey: 'user-88',
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBeNull();
    expect(res.value.challengeUrl).toContain('captcha-delivery.com/captcha/');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          call[0] === 'https://www.vinted.nl/api/v2/catalog/items?page=1&per_page=1&order=newest_first',
      ),
    ).toBe(false);
  });

  it('keeps first challenge url when retry response omits captcha url', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const challengeUrl = 'https://geo.captcha-delivery.com/captcha/?cid=test-missing-second-url';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(403, { url: challengeUrl }))
      .mockResolvedValueOnce(
        new Response('<html>challenge</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 89n,
      pickupPoint: null,
      sessionKey: 'user-89',
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBeNull();
    expect(res.value.challengeUrl).toBe(challengeUrl);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('runs checkout preflight and retries when checkout build stays blocked', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { checkout: { id: 66 } }));

    const res = await new VintedClient().buildCheckout({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 66n,
      pickupPoint: null,
      sessionKey: 'user-66',
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.checkoutUrl).toBe(
      'https://www.vinted.nl/checkout?purchase_id=66&order_id=66&order_type=transaction',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      'https://www.vinted.nl/api/v2/catalog/items?page=1&per_page=1&order=newest_first',
    );

    const finalHeaders = (fetchMock.mock.calls[3]?.[1] as RequestInit).headers as Record<string, string>;
    expect(finalHeaders.authorization).toBe('Bearer access-token');
  });

  it('uses transactions offer_requests endpoint before legacy offers endpoint', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { code: 0, message: 'ok', message_code: 'success' }));

    const res = await new VintedClient().sendOffer({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 46n,
      amount: 9.5,
      currencyCode: 'EUR',
    });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://www.vinted.nl/api/v2/transactions/46/offer_requests',
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof request.body).toBe('string');
    const body = JSON.parse((request.body as string) ?? '{}');
    expect(body).toEqual({
      offer_request: {
        price: 9.5,
        currency: 'EUR',
      },
    });
  });

  it('falls back to legacy offers endpoint when transactions offer_requests fails', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: 0, message: 'ok', message_code: 'success' }));

    const res = await new VintedClient().sendOffer({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 47n,
      amount: 10,
      currencyCode: 'EUR',
    });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://www.vinted.nl/api/v2/transactions/47/offer_requests',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.vinted.nl/api/v2/transactions/47/offers');
  });

  it('falls back to legacy offers endpoint when both transactions endpoints fail', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(200, { code: 0, message: 'ok', message_code: 'success' }));

    const res = await new VintedClient().sendOffer({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      itemId: 48n,
      amount: 10,
      currencyCode: 'EUR',
    });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://www.vinted.nl/api/v2/transactions/48/offer_requests',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://www.vinted.nl/api/v2/transactions/48/offers');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://www.vinted.nl/api/v2/offers');
  });

  it('submits checkout purchase through purchases/{id}/checkout', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(200, { success_payment_navigation: { type: 'conversation', id: 1 } }));

    const res = await new VintedClient().submitCheckoutPurchase({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      purchaseId: 778899n,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ purchased: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.vinted.nl/api/v2/purchases/778899/checkout');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(typeof request.body).toBe('string');
    const body = JSON.parse((request.body as string) ?? '{}');
    expect(body).toEqual({ components: [] });
  });

  it('reuses checkout components from response when first submit does not confirm purchase', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, {
          checkout: {
            components: {
              payment_method: { card_id: 'card-1', pay_in_method_id: 'pm-1' },
              shipping_address: { user_id: 'u-1', shipping_address_id: 'addr-1' },
              shipping_pickup_details: { point_uuid: 'point-1' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { has_bought: true }));

    const res = await new VintedClient().submitCheckoutPurchase({
      region: 'nl',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      purchaseId: 889900n,
    });

    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toEqual({ purchased: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof firstRequest.body).toBe('string');
    const firstBody = JSON.parse((firstRequest.body as string) ?? '{}');
    expect(firstBody).toEqual({ components: [] });

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(typeof secondRequest.body).toBe('string');
    const secondBody = JSON.parse((secondRequest.body as string) ?? '{}');
    expect(secondBody).toEqual({
      components: {
        payment_method: { card_id: 'card-1', pay_in_method_id: 'pm-1' },
        shipping_address: { user_id: 'u-1', shipping_address_id: 'addr-1' },
        shipping_pickup_details: { point_uuid: 'point-1' },
      },
    });
  });
});
