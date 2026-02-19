import { err, ok, type Result } from 'neverthrow';
import { logger } from '../logger.js';
import { VintedClient } from '../infra/vinted/vinted-client.js';
import { parseRegion, type VintedRegion } from '../infra/vinted/regions.js';
import { classifyCheckoutErrorMessage, type CheckoutFailureStatus } from './checkout-classification.js';
import { getAccountForUser } from './vinted-account-service.js';
import { getAccessTokenForUser } from './vinted-token-service.js';

const vinted = new VintedClient();

type CheckoutBuildResponse = Result<
  { checkoutUrl: string | null; challengeUrl?: string | null },
  { message: string }
>;

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
  | {
      status: 'blocked';
      source?: string;
      purchaseIdCandidates?: bigint[];
      challengeUrl?: string;
    }
  | { status: 'access_denied' | 'invalid_pickup_point' | 'failed' };

export type InstantBuyResult = {
  status:
    | 'purchased'
    | 'purchased_without_pickup'
    | 'manual_checkout_required'
    | 'blocked'
    | 'access_denied'
    | 'invalid_pickup_point'
    | 'failed';
  challengeUrl?: string;
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

function normalizePurchaseIdCandidates(candidates: bigint[]): bigint[] {
  const seen = new Set<string>();
  const normalized: bigint[] = [];
  for (const candidate of candidates) {
    if (candidate <= 0n) continue;
    const key = candidate.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(candidate);
  }
  return normalized;
}

function getPurchaseIdCandidatesFromCheckoutResult(result: CheckoutBuildResult): bigint[] {
  if (result.status !== 'blocked') return [];
  return normalizePurchaseIdCandidates(result.purchaseIdCandidates ?? []);
}

function withMergedPurchaseIdCandidates(
  base: CheckoutBuildResult,
  extraCandidates: bigint[],
): CheckoutBuildResult {
  if (base.status !== 'blocked') return base;
  const merged = normalizePurchaseIdCandidates([
    ...getPurchaseIdCandidatesFromCheckoutResult(base),
    ...extraCandidates,
  ]);
  if (merged.length === 0) return base;
  return { ...base, purchaseIdCandidates: merged };
}

function hasChallengeUrl(result: { challengeUrl?: string | null }): boolean {
  return Boolean(result.challengeUrl?.trim());
}

function extractCaptchaChallengeUrl(message: string): string | null {
  const normalized = message.replace(/\\\//g, '/');
  const match = normalized.match(/https?:\/\/[^\s"'<>]*captcha-delivery\.com\/captcha\/[^\s"'<>]*/i);
  return match?.[0]?.trim() ?? null;
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
        const challengeUrl = fallbackAttempt.value.challengeUrl?.trim() || undefined;
        logCheckoutStatus(input, 'blocked', {
          source: 'fallback_missing_checkout_url',
          checkoutItemId: checkoutItemIdValue,
          ...(challengeUrl ? { challengeUrl } : {}),
        });
        return {
          status: 'blocked',
          source: 'fallback_missing_checkout_url',
          purchaseIdCandidates: [checkoutItemId],
          ...(challengeUrl ? { challengeUrl } : {}),
        };
      }

      const fallbackFailure = classifyCheckoutErrorMessage(fallbackAttempt.error.message);
      if (fallbackFailure === 'blocked') {
        const challengeUrl = extractCaptchaChallengeUrl(fallbackAttempt.error.message) ?? undefined;
        logCheckoutStatus(input, 'blocked', {
          source: 'fallback_error',
          checkoutItemId: checkoutItemIdValue,
          ...(challengeUrl ? { challengeUrl } : {}),
        });
        return { status: 'blocked', ...(challengeUrl ? { challengeUrl } : {}) };
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
      const challengeUrl = firstAttempt.value.challengeUrl?.trim() || undefined;
      if (challengeUrl) {
        logCheckoutStatus(input, 'blocked', {
          source: 'missing_checkout_url',
          checkoutItemId: checkoutItemIdValue,
          challengeUrl,
        });
        return {
          status: 'blocked',
          source: 'missing_checkout_url',
          purchaseIdCandidates: [checkoutItemId],
          challengeUrl,
        };
      }
      if (hasPickupPoint) {
        const fallbackResult = await attemptFallbackWithoutPickup('missing_checkout_url');
        if (fallbackResult.status === 'blocked' && !fallbackResult.challengeUrl && challengeUrl) {
          return { ...fallbackResult, challengeUrl };
        }
        return fallbackResult;
      }
      logCheckoutStatus(input, 'blocked', {
        source: 'missing_checkout_url',
        checkoutItemId: checkoutItemIdValue,
        ...(challengeUrl ? { challengeUrl } : {}),
      });
      return {
        status: 'blocked',
        source: 'missing_checkout_url',
        purchaseIdCandidates: [checkoutItemId],
        ...(challengeUrl ? { challengeUrl } : {}),
      };
    }

    const firstFailure = classifyCheckoutErrorMessage(firstAttempt.error.message);
    if (firstFailure === 'invalid_pickup_point' && hasPickupPoint) {
      return attemptFallbackWithoutPickup('invalid_pickup_point');
    }

    const finalStatus = statusFromFailure(firstFailure);
    const challengeUrl = extractCaptchaChallengeUrl(firstAttempt.error.message) ?? undefined;
    const statusWithChallenge =
      finalStatus.status === 'blocked' && challengeUrl
        ? { ...finalStatus, challengeUrl }
        : finalStatus;
    logCheckoutStatus(input, finalStatus.status, { checkoutItemId: checkoutItemIdValue });
    return statusWithChallenge;
  };

  const firstResult = await attemptBuildForItemId(transactionId);
  if (firstResult.status === 'ready' || firstResult.status === 'ready_without_pickup') {
    return ok(firstResult);
  }

  const shouldRetryWithOriginalItemId =
    transactionId !== input.itemId &&
    !(firstResult.status === 'blocked' && hasChallengeUrl(firstResult)) &&
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
  const mergedCandidates = normalizePurchaseIdCandidates([
    ...getPurchaseIdCandidatesFromCheckoutResult(firstResult),
    ...getPurchaseIdCandidatesFromCheckoutResult(secondResult),
  ]);
  const mergedResult = withMergedPurchaseIdCandidates(secondResult, mergedCandidates);
  if (
    mergedResult.status === 'blocked' &&
    !mergedResult.challengeUrl &&
    firstResult.status === 'blocked' &&
    firstResult.challengeUrl
  ) {
    return ok({ ...mergedResult, challengeUrl: firstResult.challengeUrl });
  }
  return ok(mergedResult);
}

function shouldAttemptOptimisticSubmit(result: CheckoutBuildResult): boolean {
  if (result.status !== 'blocked') return false;
  if (hasChallengeUrl(result)) return false;
  const source = result.source?.toLowerCase().trim() ?? '';
  if (source !== 'missing_checkout_url' && source !== 'fallback_missing_checkout_url') {
    return false;
  }
  return getPurchaseIdCandidatesFromCheckoutResult(result).length > 0;
}

async function attemptSubmitWithoutCheckoutUrl(input: {
  discordUserId: string;
  itemId: bigint;
  region: VintedRegion;
  accessToken: string;
  refreshToken?: string;
  purchaseIdCandidates: bigint[];
  submitCheckoutPurchase: CheckoutSubmitDependencies['submitCheckoutPurchase'];
}): Promise<InstantBuyResult | null> {
  const purchaseIdCandidates = normalizePurchaseIdCandidates(input.purchaseIdCandidates);
  if (purchaseIdCandidates.length === 0) return null;

  logger.info(
    {
      discordUserId: input.discordUserId,
      itemId: input.itemId.toString(),
      purchaseIdCandidates: purchaseIdCandidates.map((candidate) => candidate.toString()),
    },
    'Trying checkout submit fallback without checkout url',
  );

  let hasManualCheckoutHint = false;
  let hasBlockedFailure = false;
  let hasAccessDeniedFailure = false;
  let hasFailedFallback = false;
  let challengeUrl: string | null = null;

  for (const purchaseId of purchaseIdCandidates) {
    logger.info(
      {
        discordUserId: input.discordUserId,
        itemId: input.itemId.toString(),
        purchaseId: purchaseId.toString(),
      },
      'Trying checkout submit fallback candidate',
    );

    const submitAttempt = await input.submitCheckoutPurchase({
      region: input.region,
      accessToken: input.accessToken,
      purchaseId,
      sessionKey: input.discordUserId,
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
    });

    if (submitAttempt.isOk()) {
      if (submitAttempt.value.purchased) {
        logger.info(
          {
            discordUserId: input.discordUserId,
            itemId: input.itemId.toString(),
            purchaseId: purchaseId.toString(),
          },
          'Checkout submit fallback candidate purchased successfully',
        );
        return { status: 'purchased' };
      }
      logger.info(
        {
          discordUserId: input.discordUserId,
          itemId: input.itemId.toString(),
          purchaseId: purchaseId.toString(),
        },
        'Checkout submit fallback candidate requires manual completion',
      );
      hasManualCheckoutHint = true;
      continue;
    }

    const submitFailure = classifyCheckoutErrorMessage(submitAttempt.error.message);
    const submitChallengeUrl = extractCaptchaChallengeUrl(submitAttempt.error.message);
    if (!challengeUrl && submitChallengeUrl) {
      challengeUrl = submitChallengeUrl;
    }
    logger.warn(
      {
        discordUserId: input.discordUserId,
        itemId: input.itemId.toString(),
        purchaseId: purchaseId.toString(),
        submitFailure,
        ...(submitChallengeUrl ? { challengeUrl: submitChallengeUrl } : {}),
        error: submitAttempt.error.message.slice(0, 240),
      },
      'Checkout submit fallback candidate failed',
    );
    if (submitFailure === 'blocked') {
      hasBlockedFailure = true;
      continue;
    }
    if (submitFailure === 'access_denied') {
      hasAccessDeniedFailure = true;
      continue;
    }
    hasFailedFallback = true;
  }

  if (hasManualCheckoutHint) {
    return { status: 'manual_checkout_required', ...(challengeUrl ? { challengeUrl } : {}) };
  }
  if (hasAccessDeniedFailure) return { status: 'access_denied' };
  if (hasBlockedFailure) return { status: 'blocked', ...(challengeUrl ? { challengeUrl } : {}) };
  if (hasFailedFallback) {
    return { status: 'manual_checkout_required', ...(challengeUrl ? { challengeUrl } : {}) };
  }

  return null;
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
    if (shouldAttemptOptimisticSubmit(checkoutAttempt.value)) {
      const token = await deps.getAccessTokenForUser({ discordUserId: input.discordUserId });
      if (token.isErr()) return err(token.error);

      const submitWithoutCheckoutUrlResult = await attemptSubmitWithoutCheckoutUrl({
        discordUserId: input.discordUserId,
        itemId: input.itemId,
        region: token.value.region,
        accessToken: token.value.accessToken,
        refreshToken: token.value.refreshToken,
        purchaseIdCandidates: getPurchaseIdCandidatesFromCheckoutResult(checkoutAttempt.value),
        submitCheckoutPurchase: deps.submitCheckoutPurchase,
      });

      if (submitWithoutCheckoutUrlResult) {
        logger.info(
          {
            discordUserId: input.discordUserId,
            itemId: input.itemId.toString(),
            status: submitWithoutCheckoutUrlResult.status,
            ...(submitWithoutCheckoutUrlResult.challengeUrl
              ? { challengeUrl: submitWithoutCheckoutUrlResult.challengeUrl }
              : {}),
          },
          'Checkout submit fallback finished',
        );
        return ok(submitWithoutCheckoutUrlResult);
      }
    }

    if (checkoutAttempt.value.status === 'blocked') {
      return ok({
        status: checkoutAttempt.value.status,
        ...(checkoutAttempt.value.challengeUrl ? { challengeUrl: checkoutAttempt.value.challengeUrl } : {}),
      });
    }
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
    const challengeUrl = extractCaptchaChallengeUrl(submitAttempt.error.message) ?? undefined;
    if (submitFailure === 'blocked') {
      return ok({ status: 'blocked', ...(challengeUrl ? { challengeUrl } : {}) });
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
