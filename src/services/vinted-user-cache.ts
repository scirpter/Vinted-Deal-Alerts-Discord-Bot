import { VintedClient, type VintedUser } from '../infra/vinted/vinted-client.js';
import type { VintedRegion } from '../infra/vinted/regions.js';

type Cached = { user: VintedUser; expiresAtMs: number };

const cache = new Map<number, Cached>();
const vinted = new VintedClient();

export async function getSellerInfo(input: {
  region: VintedRegion;
  accessToken: string;
  userId: number;
}): Promise<VintedUser | null> {
  const cached = cache.get(input.userId);
  if (cached && Date.now() < cached.expiresAtMs) return cached.user;

  const res = await vinted.getUser({
    region: input.region,
    accessToken: input.accessToken,
    userId: input.userId,
  });
  if (res.isErr()) return null;

  cache.set(input.userId, { user: res.value, expiresAtMs: Date.now() + 60 * 60 * 1000 });
  return res.value;
}

