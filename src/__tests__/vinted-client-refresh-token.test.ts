import { describe, expect, it, vi } from 'vitest';
import { VintedClient } from '../infra/vinted/vinted-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VintedClient.refreshToken', () => {
  it('does not retry invalid_grant responses', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(401, { error: 'invalid_grant' }));

    const res = await new VintedClient().refreshToken({ region: 'de', refreshToken: 'token' });

    expect(res.isErr()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRestore();
    delete process.env.VINTED_HTTP_BACKEND;
  });

  it('still retries transient refresh failures', async () => {
    process.env.VINTED_HTTP_BACKEND = 'fetch';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(500, { error: 'upstream_1' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'upstream_2' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          created_at: 1,
        }),
      );

    const res = await new VintedClient().refreshToken({ region: 'de', refreshToken: 'token' });

    expect(res.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockRestore();
    delete process.env.VINTED_HTTP_BACKEND;
  });
});
