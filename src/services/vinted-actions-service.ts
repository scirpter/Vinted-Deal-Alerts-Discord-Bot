import { err, ok, type Result } from 'neverthrow';
import { logger } from '../logger.js';
import { VintedClient } from '../infra/vinted/vinted-client.js';
import { parseRegion, type VintedRegion } from '../infra/vinted/regions.js';
import { classifyCheckoutErrorMessage, type CheckoutFailureStatus } from './checkout-classification.js';
import { getAccountForUser } from './vinted-account-service.js';
import { getAccessTokenForUser } from './vinted-token-service.js';

const vinted = new VintedClient();

type CheckoutBuildResponse = Result<{ checkoutUrl: string | null }, { message: string }>;

type CheckoutBuildDependencies = {
  getAccessTokenForUser: typeof getAccessTokenForUser;
  getAccountForUser: typeof getAccountForUser;
  parseRegion: typeof parseRegion;
  createConversationTransaction: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    sellerUserId: number;
    sessionKey?: string;
  }) => Promise<Result<{ transactionId: bigint }, { message: string }>>;
  buildCheckout: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    pickupPoint?: string | null;
    sessionKey?: string;
  }) => Promise<CheckoutBuildResponse>;
};

type CheckoutSubmitDependencies = CheckoutBuildDependencies & {
  submitCheckoutPurchase: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    purchaseId: bigint;
    sessionKey?: string;
  }) => Promise<Result<{ purchased: boolean }, { message: string }>>;
};

type OfferDependencies = {
  getAccessTokenForUser: typeof getAccessTokenForUser;
  createConversationTransaction: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    sellerUserId: number;
    sessionKey?: string;
  }) => Promise<Result<{ transactionId: bigint }, { message: string }>>;
  sendOffer: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    amount: number;
    currencyCode: string;
    sessionKey?: string;
  }) => Promise<Result<{ sent: true }, { message: string }>>;
  estimateOfferWithFees: (input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    amount: number;
    currencyCode: string;
    sessionKey?: string;
  }) => Promise<Result<{ total: string; serviceFee: string | null }, { message: string }>>;
};

const defaultCheckoutDependencies: CheckoutBuildDependencies = {
  getAccessTokenForUser,
  getAccountForUser,
  parseRegion,
  createConversationTransaction: async (input) => vinted.createConversationTransaction(input),
  buildCheckout: async (input) => vinted.buildCheckout(input),
};

const defaultCheckoutSubmitDependencies: CheckoutSubmitDependencies = {
  ...defaultCheckoutDependencies,
  submitCheckoutPurchase: async (input) => vinted.submitCheckoutPurchase(input),
};

const defaultOfferDependencies: OfferDependencies = {
  getAccessTokenForUser,
  createConversationTransaction: async (input) => vinted.createConversationTransaction(input),
  sendOffer: async (input) => vinted.sendOffer(input),
  estimateOfferWithFees: async (input) => vinted.estimateOfferWithFees(input),
};

export type CheckoutBuildResult =
  | { status: 'ready'; checkoutUrl: string }
  | { status: 'ready_without_pickup'; checkoutUrl: string }
  | { status: 'blocked' | 'access_denied' | 'invalid_pickup_point' | 'failed' };

export type InstantBuyResult = {
  status:
    | 'purchased'
    | 'purchased_without_pickup'
    | 'manual_checkout_required'
    | 'blocked'
    | 'access_denied'
    | 'invalid_pickup_point'
    | 'failed';
};

export type OfferAttemptResult =
  | { sent: true }
  | {
      sent: false;
      status: OfferFailureStatus;
      estimate?: { total: string; serviceFee: string | null };
    };

type OfferFailureStatus = 'blocked' | 'access_denied' | 'failed';

function statusFromFailure(failure: CheckoutFailureStatus): CheckoutBuildResult {
  if (failure === 'blocked') return { status: 'blocked' };
  if (failure === 'access_denied') return { status: 'access_denied' };
  if (failure === 'invalid_pickup_point') return { status: 'invalid_pickup_point' };
  return { status: 'failed' };
}

function logCheckoutStatus(input: { discordUserId: string; itemId: bigint }, status: string, extra?: object) {
  logger.info(
    { discordUserId: input.discordUserId, itemId: input.itemId.toString(), status, ...extra },
    'Checkout status evaluated',
  );
}

function parseBigintCandidate(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function extractPurchaseIdFromCheckoutUrl(checkoutUrl: string): bigint | null {
  try {
    const parsed = new URL(checkoutUrl);
    return parseBigintCandidate(parsed.searchParams.get('purchase_id'));
  } catch {
    const match = checkoutUrl.match(/[?&]purchase_id=(\d+)/i);
    return match?.[1] ? parseBigintCandidate(match[1]) : null;
  }
}

async function resolveTransactionId(input: {
  discordUserId: string;
  itemId: bigint;
  sellerUserId?: number;
  region: VintedRegion;
  accessToken: string;
  refreshToken?: string;
  deps: Pick<CheckoutBuildDependencies, 'createConversationTransaction'>;
}): Promise<bigint> {
  if (!input.sellerUserId || !Number.isInteger(input.sellerUserId) || input.sellerUserId <= 0) {
    return input.itemId;
  }

  const transaction = await input.deps.createConversationTransaction({
    region: input.region,
    accessToken: input.accessToken,
    itemId: input.itemId,
    sellerUserId: input.sellerUserId,
    sessionKey: input.discordUserId,
    ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
  });

  if (transaction.isOk()) {
    logger.info(
      {
        discordUserId: input.discordUserId,
        itemId: input.itemId.toString(),
        sellerUserId: input.sellerUserId,
        region: input.region,
        transactionId: transaction.value.transactionId.toString(),
      },
      'Resolved conversation transaction id',
    );
    return transaction.value.transactionId;
  }

  logger.info(
    {
      discordUserId: input.discordUserId,
      itemId: input.itemId.toString(),
      sellerUserId: input.sellerUserId,
      region: input.region,
      error: transaction.error.message,
    },
    'Failed to resolve conversation transaction id; falling back to item id',
  );

  return input.itemId;
}

export async function toggleFavourite(input: {
  discordUserId: string;
  itemId: bigint;
}): Promise<Result<{ liked: boolean; known: boolean }, Error>> {
  const token = await getAccessTokenForUser({ discordUserId: input.discordUserId });
  if (token.isErr()) return err(token.error);

  const res = await vinted.toggleFavourite({
    region: token.value.region,
    accessToken: token.value.accessToken,
    refreshToken: token.value.refreshToken,
    itemId: input.itemId,
    sessionKey: input.discordUserId,
  });
  if (res.isErr()) {
    const failure = classifyCheckoutErrorMessage(res.error.message);
    if (failure === 'access_denied') {
      return err(
        new Error(
          'Vinted verweigert Favorisieren für dieses Konto (access_denied). Das ist meist eine Vinted-Konto/IP-Sperre für API-Aktionen; ein frischer `refresh_token_web` hilft nicht immer.',
        ),
      );
    }
    if (failure === 'blocked') {
      return err(
        new Error(
          'Favorisieren wird aktuell durch Vinted-Schutzmaßnahmen blockiert. Bitte versuche es später erneut oder nutze direkt Vinted.',
        ),
      );
    }
    return err(new Error('Favorit konnte nicht geändert werden.'));
  }
  return ok(res.value);
}

export async function attemptCheckoutBuild(
  input: {
    discordUserId: string;
    itemId: bigint;
    sellerUserId?: number;
  },
  deps: CheckoutBuildDependencies = defaultCheckoutDependencies,
): Promise<Result<CheckoutBuildResult, Error>> {
  const token = await deps.getAccessTokenForUser({ discordUserId: input.discordUserId });
  if (token.isErr()) return err(token.error);

  const account = await deps.getAccountForUser({ discordUserId: input.discordUserId });
  if (account.isErr()) return err(account.error);

  const regionRes = deps.parseRegion(account.value.region);
  if (regionRes.isErr()) return err(regionRes.error);
  const hasPickupPoint = Boolean(account.value.pickupPoint);
  const transactionId = await resolveTransactionId({
    discordUserId: input.discordUserId,
    itemId: input.itemId,
    region: regionRes.value,
    accessToken: token.value.accessToken,
    deps,
    ...(input.sellerUserId !== undefined ? { sellerUserId: input.sellerUserId } : {}),
    ...(token.value.refreshToken ? { refreshToken: token.value.refreshToken } : {}),
  });

  const attemptBuildForItemId = async (checkoutItemId: bigint): Promise<CheckoutBuildResult> => {
    const checkoutItemIdValue = checkoutItemId.toString();

    const attemptFallbackWithoutPickup = async (source: string): Promise<CheckoutBuildResult> => {
      logCheckoutStatus(input, 'fallback_without_pickup', { source, checkoutItemId: checkoutItemIdValue });

      const fallbackAttempt = await deps.buildCheckout({
        region: regionRes.value,
        accessToken: token.value.accessToken,
        refreshToken: token.value.refreshToken,
        itemId: checkoutItemId,
        sessionKey: input.discordUserId,
      });

      if (fallbackAttempt.isOk()) {
        if (fallbackAttempt.value.checkoutUrl) {
          logCheckoutStatus(input, 'ready_without_pickup', { checkoutItemId: checkoutItemIdValue });
          return { status: 'ready_without_pickup', checkoutUrl: fallbackAttempt.value.checkoutUrl };
        }
        logCheckoutStatus(input, 'blocked', {
          source: 'fallback_missing_checkout_url',
          checkoutItemId: checkoutItemIdValue,
        });
        return { status: 'blocked' };
      }

      const fallbackFailure = classifyCheckoutErrorMessage(fallbackAttempt.error.message);
      if (fallbackFailure === 'blocked') {
        logCheckoutStatus(input, 'blocked', { source: 'fallback_error', checkoutItemId: checkoutItemIdValue });
        return { status: 'blocked' };
      }
      if (fallbackFailure === 'access_denied') {
        logCheckoutStatus(input, 'access_denied', {
          source: 'fallback_error',
          checkoutItemId: checkoutItemIdValue,
        });
        return { status: 'access_denied' };
      }

      logCheckoutStatus(input, 'invalid_pickup_point', {
        fallbackStatus: fallbackFailure,
        checkoutItemId: checkoutItemIdValue,
      });
      return { status: 'invalid_pickup_point' };
    };

    const firstAttempt = await deps.buildCheckout({
      region: regionRes.value,
      accessToken: token.value.accessToken,
      refreshToken: token.value.refreshToken,
      itemId: checkoutItemId,
      pickupPoint: account.value.pickupPoint,
      sessionKey: input.discordUserId,
    });

    if (firstAttempt.isOk()) {
      if (firstAttempt.value.checkoutUrl) {
        return { status: 'ready', checkoutUrl: firstAttempt.value.checkoutUrl };
      }
      if (hasPickupPoint) {
        return attemptFallbackWithoutPickup('missing_checkout_url');
      }
      logCheckoutStatus(input, 'blocked', { source: 'missing_checkout_url', checkoutItemId: checkoutItemIdValue });
      return { status: 'blocked' };
    }

    const firstFailure = classifyCheckoutErrorMessage(firstAttempt.error.message);
    if (firstFailure === 'invalid_pickup_point' && hasPickupPoint) {
      return attemptFallbackWithoutPickup('invalid_pickup_point');
    }

    const finalStatus = statusFromFailure(firstFailure);
    logCheckoutStatus(input, finalStatus.status, { checkoutItemId: checkoutItemIdValue });
    return finalStatus;
  };

  const firstResult = await attemptBuildForItemId(transactionId);
  if (firstResult.status === 'ready' || firstResult.status === 'ready_without_pickup') {
    return ok(firstResult);
  }

  const shouldRetryWithOriginalItemId =
    transactionId !== input.itemId &&
    (firstResult.status === 'blocked' ||
      firstResult.status === 'failed' ||
      firstResult.status === 'invalid_pickup_point');

  if (!shouldRetryWithOriginalItemId) {
    return ok(firstResult);
  }

  logger.info(
    {
      discordUserId: input.discordUserId,
      itemId: input.itemId.toString(),
      transactionId: transactionId.toString(),
      firstStatus: firstResult.status,
    },
    'Retrying checkout build with original item id',
  );

  const secondResult = await attemptBuildForItemId(input.itemId);
  return ok(secondResult);
}

export async function attemptMakeOffer(
  input: {
    discordUserId: string;
    itemId: bigint;
    sellerUserId?: number;
    amount: number;
  },
  deps: OfferDependencies = defaultOfferDependencies,
): Promise<Result<OfferAttemptResult, Error>> {
  const token = await deps.getAccessTokenForUser({ discordUserId: input.discordUserId });
  if (token.isErr()) return err(token.error);

  const transactionId = await resolveTransactionId({
    discordUserId: input.discordUserId,
    itemId: input.itemId,
    region: token.value.region,
    accessToken: token.value.accessToken,
    deps,
    ...(input.sellerUserId !== undefined ? { sellerUserId: input.sellerUserId } : {}),
    ...(token.value.refreshToken ? { refreshToken: token.value.refreshToken } : {}),
  });

  const sendAttempt = await deps.sendOffer({
    region: token.value.region,
    accessToken: token.value.accessToken,
    refreshToken: token.value.refreshToken,
    itemId: transactionId,
    amount: input.amount,
    currencyCode: 'EUR',
    sessionKey: input.discordUserId,
  });

  if (sendAttempt.isOk()) {
    return ok({ sent: true });
  }

  const sendFailure = classifyCheckoutErrorMessage(sendAttempt.error.message);
  const finalStatus: OfferFailureStatus =
    sendFailure === 'access_denied' || sendFailure === 'blocked' ? sendFailure : 'failed';

  const estimate = await deps.estimateOfferWithFees({
    region: token.value.region,
    accessToken: token.value.accessToken,
    refreshToken: token.value.refreshToken,
    itemId: input.itemId,
    amount: input.amount,
    currencyCode: 'EUR',
    sessionKey: input.discordUserId,
  });

  if (estimate.isOk()) {
    return ok({ sent: false, status: finalStatus, estimate: estimate.value });
  }

  return ok({ sent: false, status: finalStatus });
}

export async function attemptInstantBuy(
  input: {
    discordUserId: string;
    itemId: bigint;
    sellerUserId?: number;
  },
  deps: CheckoutSubmitDependencies = defaultCheckoutSubmitDependencies,
): Promise<Result<InstantBuyResult, Error>> {
  const checkoutAttempt = await attemptCheckoutBuild(input, deps);
  if (checkoutAttempt.isErr()) return err(checkoutAttempt.error);

  if (
    checkoutAttempt.value.status !== 'ready' &&
    checkoutAttempt.value.status !== 'ready_without_pickup'
  ) {
    return ok({ status: checkoutAttempt.value.status });
  }

  const checkout = checkoutAttempt.value;
  const purchaseId = extractPurchaseIdFromCheckoutUrl(checkout.checkoutUrl);
  if (!purchaseId) {
    logger.info(
      {
        discordUserId: input.discordUserId,
        itemId: input.itemId.toString(),
        checkoutUrl: checkout.checkoutUrl,
      },
      'Direct buy skipped: checkout URL did not contain purchase_id',
    );
    return ok({ status: 'failed' });
  }

  const token = await deps.getAccessTokenForUser({ discordUserId: input.discordUserId });
  if (token.isErr()) return err(token.error);

  const submitAttempt = await deps.submitCheckoutPurchase({
    region: token.value.region,
    accessToken: token.value.accessToken,
    purchaseId,
    sessionKey: input.discordUserId,
    ...(token.value.refreshToken ? { refreshToken: token.value.refreshToken } : {}),
  });

  if (submitAttempt.isErr()) {
    const submitFailure = classifyCheckoutErrorMessage(submitAttempt.error.message);
    if (submitFailure === 'blocked') {
      return ok({ status: 'blocked' });
    }
    if (submitFailure === 'access_denied') {
      return ok({ status: 'access_denied' });
    }
    return ok({ status: 'failed' });
  }

  if (submitAttempt.value.purchased) {
    if (checkout.status === 'ready_without_pickup') {
      return ok({ status: 'purchased_without_pickup' });
    }
    return ok({ status: 'purchased' });
  }

  return ok({ status: 'manual_checkout_required' });
}
