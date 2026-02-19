export type CheckoutFailureStatus = 'blocked' | 'access_denied' | 'invalid_pickup_point' | 'failed';

function extractStatusCode(message: string): number | null {
  const match = message.match(/\((\d{3})\)/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

export function classifyCheckoutErrorMessage(message: string): CheckoutFailureStatus {
  const lower = message.toLowerCase();
  const normalized = normalizeForMatch(message);
  const statusCode = extractStatusCode(message);

  const hasAccessDeniedHint =
    lower.includes('"message_code":"access_denied"') ||
    lower.includes('message_code":"access_denied') ||
    lower.includes('message_code=access_denied') ||
    lower.includes('access_denied') ||
    lower.includes('"code":106') ||
    lower.includes('access denied') ||
    normalized.includes('acces refuse');

  if (hasAccessDeniedHint && (statusCode === 401 || statusCode === 403 || statusCode === null)) {
    return 'access_denied';
  }

  if (
    lower.includes('blockiert') ||
    lower.includes('cloudflare') ||
    lower.includes('captcha') ||
    lower.includes('just a moment') ||
    statusCode === 403
  ) {
    return 'blocked';
  }

  const hasPickupHint =
    lower.includes('pickup') ||
    lower.includes('abholpunkt') ||
    lower.includes('relay') ||
    lower.includes('parcel');

  if (hasPickupHint && (statusCode === 400 || statusCode === 404 || statusCode === 422)) {
    return 'invalid_pickup_point';
  }

  if (hasPickupHint) {
    return 'invalid_pickup_point';
  }

  return 'failed';
}
