import { err, ok, type Result } from 'neverthrow';
import { spawn } from 'node:child_process';
import pRetry, { AbortError } from 'p-retry';
import { logger } from '../../logger.js';
import { baseUrlForRegion, type VintedRegion } from './regions.js';

export type VintedTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  createdAt: number;
};

export type VintedCatalogItem = {
  id: bigint;
  title: string;
  url: string;
  price: { amount: string; currency_code: string };
  size_title: string;
  status: string;
  photoUrl: string | null;
  updatedAt: Date | null;
  user: { id: number; login: string; profile_url: string };
};

export type VintedUser = {
  id: number;
  login: string;
  feedbackReputation: number | null;
  feedbackCount: number | null;
};

type VintedError = { message: string };

function toVintedError(message: string): VintedError {
  return { message };
}

const DEFAULT_CSRF_TOKEN = '75f6c9fa-dc8e-4e52-a000-e09dd4084b3e';
const DEFAULT_SESSION_SCOPE = '__global__';
const SESSION_WARMUP_TTL_MS = 2 * 60 * 1000;
const DEFAULT_INCOGNIA_APP_ID = '0e806f9a-66d6-4c7e-bd94-382236e16bc8';
const INCOGNIA_APP_ID_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const INCOGNIA_TOKEN_CACHE_TTL_MS = 20 * 1000;
const INCOGNIA_MISSING_APP_ID_RETRY_MS = 5 * 60 * 1000;
const INCOGNIA_WARNING_THROTTLE_MS = 60 * 1000;

const cookieJarByScopeHost = new Map<string, Map<string, Map<string, string>>>();
const dynamicHeadersByScopeHost = new Map<string, Map<string, Map<string, string>>>();
const sessionWarmupByScopeHost = new Map<string, number>();
const incogniaAppIdByHost = new Map<string, { appId: string | null; expiresAt: number }>();
const incogniaTokenByScopeHost = new Map<string, { token: string; expiresAt: number }>();
const incogniaInitPromiseByAppId = new Map<string, Promise<void>>();
type IncogniaWebSdkLike = {
  init: (input: string | { appId?: string; customDomain?: string }) => Promise<void>;
  generateRequestToken: (input?: { askForGeolocation?: boolean; maxLength?: number }) => Promise<string | undefined>;
};
let incogniaWebSdkPromise: Promise<IncogniaWebSdkLike> | null = null;
let lastIncogniaWarningAt = 0;

function normalizeSessionScope(sessionScope?: string): string {
  const trimmed = sessionScope?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_SESSION_SCOPE;
}

function shouldAutoGenerateIncogniaRequestToken(): boolean {
  const raw = process.env.VINTED_AUTO_INCOGNIA_REQUEST_TOKEN?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return process.env.NODE_ENV !== 'test';
}

function warnAutoIncognia(message: string, extra?: object): void {
  const now = Date.now();
  if (now - lastIncogniaWarningAt < INCOGNIA_WARNING_THROTTLE_MS) return;
  lastIncogniaWarningAt = now;
  logger.warn({ ...extra }, message);
}

function isIncogniaWebSdkLike(value: unknown): value is IncogniaWebSdkLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.init === 'function' && typeof candidate.generateRequestToken === 'function';
}

async function getIncogniaWebSdk(): Promise<IncogniaWebSdkLike> {
  if (incogniaWebSdkPromise) return incogniaWebSdkPromise;

  incogniaWebSdkPromise = import('@incognia/web-sdk').then((module): IncogniaWebSdkLike => {
    const asUnknown = module as unknown;
    if (isIncogniaWebSdkLike(asUnknown)) return asUnknown;
    const maybeDefault =
      asUnknown && typeof asUnknown === 'object' && 'default' in asUnknown
        ? (asUnknown as { default: unknown }).default
        : null;
    if (isIncogniaWebSdkLike(maybeDefault)) return maybeDefault;
    throw new Error('Invalid Incognia Web SDK module shape.');
  });

  return incogniaWebSdkPromise;
}

function parseStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function shouldRetryWithAuthorization(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('(401)') || lower.includes('(403)') || lower.includes('access_denied');
}

function isExplicitPayloadErrorCode(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }

  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (normalized === '0' || normalized === 'ok' || normalized === 'success') return false;

  const parsed = Number.parseInt(normalized, 10);
  if (Number.isFinite(parsed)) return parsed !== 0;
  return true;
}

function extractErrorsPayloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;

  const parts: string[] = [];
  const seenParts = new Set<string>();

  const pushMessage = (value: unknown) => {
    const trimmed =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value.trim()
          : '';
    if (trimmed.length === 0 || seenParts.has(trimmed)) return;
    seenParts.add(trimmed);
    parts.push(trimmed);
  };

  const pushFromObject = (value: Record<string, unknown>) => {
    pushMessage(value.message);
    pushMessage(value.message_code);
    pushMessage(value.title);
    pushMessage(value.code);
  };

  const hasErrorsField = Object.hasOwn(raw, 'errors');
  if (hasErrorsField) {
    const errors = raw.errors;

    if (Array.isArray(errors)) {
      for (const entry of errors.slice(0, 3)) {
        if (typeof entry === 'string') {
          pushMessage(entry);
        } else if (entry && typeof entry === 'object') {
          pushFromObject(entry as Record<string, unknown>);
        }
      }
    } else if (typeof errors === 'string') {
      pushMessage(errors);
    } else if (errors && typeof errors === 'object') {
      pushFromObject(errors as Record<string, unknown>);
    }
  }

  const status = parseStatusCode(raw.status);
  const hasTopLevelCodeError = isExplicitPayloadErrorCode(raw.code);
  const hasTopLevelMessageCodeError = isExplicitPayloadErrorCode(raw.message_code);
  const hasErrorField = typeof raw.error === 'string' && raw.error.trim().length > 0;
  const shouldTreatAsError =
    hasErrorsField ||
    hasErrorField ||
    (status !== null && status >= 400) ||
    hasTopLevelCodeError ||
    hasTopLevelMessageCodeError;

  if (!shouldTreatAsError) return null;

  pushMessage(raw.error);
  pushMessage(raw.error_description);
  pushMessage(raw.message);
  pushMessage(raw.message_code);
  pushMessage(raw.code);

  const bodyMessage =
    parts.length > 0 ? parts.join(' | ') : JSON.stringify(raw).slice(0, 220) || 'Unknown API error payload.';

  if (status !== null) {
    return `Vinted request failed (${status}). ${bodyMessage}`;
  }
  return `Vinted request failed (payload error). ${bodyMessage}`;
}

function readHeaderCaseInsensitive(
  headers: Record<string, string>,
  headerName: string,
): string | undefined {
  const normalizedHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedHeaderName) return value;
  }
  return undefined;
}

function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  headerName: string,
  value: string,
): void {
  const normalizedHeaderName = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedHeaderName) {
      headers[key] = value;
      return;
    }
  }
  headers[headerName] = value;
}

function parseCookieHeader(value: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const rawPart of value.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = part.slice(0, eqIndex).trim();
    const cookieValue = part.slice(eqIndex + 1).trim();
    if (!name) continue;
    cookies.set(name, cookieValue);
  }
  return cookies;
}

function serializeCookieHeader(cookies: Map<string, string>): string {
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function mergeCookieHeaders(values: Array<string | undefined>): string | undefined {
  const merged = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    for (const [name, cookieValue] of parseCookieHeader(value)) {
      merged.set(name, cookieValue);
    }
  }
  if (merged.size === 0) return undefined;
  return serializeCookieHeader(merged);
}

function parseCookiePairFromSetCookie(setCookieHeader: string): [string, string] | null {
  const pairPart = setCookieHeader.split(';', 1)[0]?.trim();
  if (!pairPart) return null;
  const eqIndex = pairPart.indexOf('=');
  if (eqIndex <= 0) return null;
  const name = pairPart.slice(0, eqIndex).trim();
  const value = pairPart.slice(eqIndex + 1).trim();
  if (!name) return null;
  return [name, value];
}

function resolveHostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getCookiesForScopeHost(input: {
  sessionScope: string;
  host: string;
  create: boolean;
}): Map<string, string> | undefined {
  const scopeMap = cookieJarByScopeHost.get(input.sessionScope);
  if (!scopeMap) {
    if (!input.create) return undefined;
    const nextScopeMap = new Map<string, Map<string, string>>();
    const cookies = new Map<string, string>();
    nextScopeMap.set(input.host, cookies);
    cookieJarByScopeHost.set(input.sessionScope, nextScopeMap);
    return cookies;
  }

  const cookies = scopeMap.get(input.host);
  if (!cookies) {
    if (!input.create) return undefined;
    const nextCookies = new Map<string, string>();
    scopeMap.set(input.host, nextCookies);
    return nextCookies;
  }
  return cookies;
}

function getHeadersForScopeHost(input: {
  sessionScope: string;
  host: string;
  create: boolean;
}): Map<string, string> | undefined {
  const scopeMap = dynamicHeadersByScopeHost.get(input.sessionScope);
  if (!scopeMap) {
    if (!input.create) return undefined;
    const nextScopeMap = new Map<string, Map<string, string>>();
    const headers = new Map<string, string>();
    nextScopeMap.set(input.host, headers);
    dynamicHeadersByScopeHost.set(input.sessionScope, nextScopeMap);
    return headers;
  }

  const headers = scopeMap.get(input.host);
  if (!headers) {
    if (!input.create) return undefined;
    const nextHeaders = new Map<string, string>();
    scopeMap.set(input.host, nextHeaders);
    return nextHeaders;
  }
  return headers;
}

function getCookieHeaderFromJar(url: string, sessionScope?: string): string | undefined {
  const host = resolveHostFromUrl(url);
  if (!host) return undefined;
  const scopeKey = normalizeSessionScope(sessionScope);
  const cookies = getCookiesForScopeHost({ sessionScope: scopeKey, host, create: false });
  if (!cookies || cookies.size === 0) return undefined;
  return serializeCookieHeader(cookies);
}

function setCookiesInJar(url: string, setCookieHeaders: string[], sessionScope?: string): void {
  const host = resolveHostFromUrl(url);
  if (!host || setCookieHeaders.length === 0) return;
  const scopeKey = normalizeSessionScope(sessionScope);
  const cookies = getCookiesForScopeHost({ sessionScope: scopeKey, host, create: true });
  if (!cookies) return;

  for (const headerValue of setCookieHeaders) {
    const parsed = parseCookiePairFromSetCookie(headerValue);
    if (!parsed) continue;
    const [name, value] = parsed;
    if (value.length === 0) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

function getDynamicHeadersForUrl(url: string, sessionScope?: string): Record<string, string> {
  const host = resolveHostFromUrl(url);
  if (!host) return {};
  const scopeKey = normalizeSessionScope(sessionScope);
  const headers = getHeadersForScopeHost({ sessionScope: scopeKey, host, create: false });
  if (!headers || headers.size === 0) return {};
  return Object.fromEntries(headers.entries());
}

function setDynamicHeaderForUrl(input: {
  url: string;
  headerName: string;
  value: string;
  sessionScope?: string | undefined;
}): void {
  const host = resolveHostFromUrl(input.url);
  if (!host) return;
  const scopeKey = normalizeSessionScope(input.sessionScope);
  const headers = getHeadersForScopeHost({ sessionScope: scopeKey, host, create: true });
  if (!headers) return;
  headers.set(input.headerName.toLowerCase(), input.value);
}

function rememberResponseHeadersForSession(input: {
  url: string;
  headers: Headers;
  sessionScope?: string | undefined;
}): void {
  const rememberHeader = (headerName: string) => {
    const value = input.headers.get(headerName)?.trim();
    if (!value) return;
    setDynamicHeaderForUrl({
      url: input.url,
      headerName,
      value,
      sessionScope: input.sessionScope,
    });
  };

  rememberHeader('x-anon-id');
  rememberHeader('x-v-udt');
  rememberHeader('x-incognia-request-token');
}

function splitCombinedSetCookieHeader(headerValue: string): string[] {
  const result: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let i = 0; i < headerValue.length; i++) {
    if (
      !inExpires &&
      headerValue.slice(i, i + 8).toLowerCase() === 'expires='
    ) {
      inExpires = true;
      i += 7;
      continue;
    }

    const current = headerValue[i];
    if (inExpires && current === ';') {
      inExpires = false;
      continue;
    }

    if (!inExpires && current === ',') {
      const part = headerValue.slice(start, i).trim();
      if (part.length > 0) result.push(part);
      start = i + 1;
    }
  }

  const tail = headerValue.slice(start).trim();
  if (tail.length > 0) result.push(tail);
  return result;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withSetCookie.getSetCookie === 'function') {
    try {
      return withSetCookie.getSetCookie().filter((value) => value.trim().length > 0);
    } catch {
      // fall through
    }
  }

  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return splitCombinedSetCookieHeader(combined);
}

function extractIncogniaAppIdFromHtml(html: string): string | null {
  const directMatch = html.match(/"INCOGNIA_WEB_CLIENT_SIDE_KEY":"([^"]+)"/);
  if (directMatch?.[1] && directMatch[1] !== '$undefined') {
    return directMatch[1];
  }

  const escapedMatch = html.match(/\\"INCOGNIA_WEB_CLIENT_SIDE_KEY\\":\\"([^"\\]+)\\"/);
  if (escapedMatch?.[1] && escapedMatch[1] !== '$undefined') {
    return escapedMatch[1];
  }

  return null;
}

async function resolveIncogniaAppIdForUrl(input: {
  url: string;
  sessionScope?: string | undefined;
}): Promise<string | null> {
  const fromEnv = process.env.VINTED_INCOGNIA_APP_ID?.trim();
  if (fromEnv) return fromEnv;

  const host = resolveHostFromUrl(input.url);
  if (!host) return null;

  const now = Date.now();
  const cached = incogniaAppIdByHost.get(host);
  if (cached && cached.expiresAt > now) return cached.appId;

  const origin = (() => {
    try {
      return new URL(input.url).origin;
    } catch {
      return null;
    }
  })();
  if (!origin) return null;

  const homepageUrl = `${origin}/`;
  const response = await fetch(homepageUrl, {
    method: 'GET',
    headers: buildRequestHeaders({
      url: homepageUrl,
      includeUserAgent: true,
      sessionScope: input.sessionScope,
    }),
  }).catch((error: unknown) => {
    warnAutoIncognia('Failed to fetch Vinted homepage for Incognia app id discovery', { err: error });
    return null;
  });

  if (!response) {
    incogniaAppIdByHost.set(host, {
      appId: DEFAULT_INCOGNIA_APP_ID,
      expiresAt: now + INCOGNIA_MISSING_APP_ID_RETRY_MS,
    });
    return DEFAULT_INCOGNIA_APP_ID;
  }

  const setCookieHeaders = getSetCookieHeaders(response.headers);
  if (setCookieHeaders.length > 0) {
    setCookiesInJar(homepageUrl, setCookieHeaders, input.sessionScope);
  }
  rememberResponseHeadersForSession({
    url: homepageUrl,
    headers: response.headers,
    sessionScope: input.sessionScope,
  });

  const html = await response.text().catch(() => '');
  const appId = extractIncogniaAppIdFromHtml(html);
  if (!appId) {
    incogniaAppIdByHost.set(host, {
      appId: DEFAULT_INCOGNIA_APP_ID,
      expiresAt: now + INCOGNIA_MISSING_APP_ID_RETRY_MS,
    });
    return DEFAULT_INCOGNIA_APP_ID;
  }

  incogniaAppIdByHost.set(host, { appId, expiresAt: now + INCOGNIA_APP_ID_CACHE_TTL_MS });
  return appId;
}

async function ensureIncogniaSdkInitialized(appId: string): Promise<void> {
  const existing = incogniaInitPromiseByAppId.get(appId);
  if (existing) {
    await existing;
    return;
  }

  const initPromise: Promise<void> = (async () => {
    const incogniaWebSdk = await getIncogniaWebSdk();
    await incogniaWebSdk.init({ appId, customDomain: 'metrics.vinted.lt' });
  })().catch((error: unknown) => {
    incogniaInitPromiseByAppId.delete(appId);
    throw error;
  });

  incogniaInitPromiseByAppId.set(appId, initPromise);
  await initPromise;
}

async function resolveAutoIncogniaRequestToken(input: {
  url: string;
  sessionScope?: string | undefined;
}): Promise<string | null> {
  if (!shouldAutoGenerateIncogniaRequestToken()) return null;
  if (process.env.VINTED_INCOGNIA_REQUEST_TOKEN?.trim()) return null;

  const host = resolveHostFromUrl(input.url);
  if (!host) return null;
  const scopeKey = normalizeSessionScope(input.sessionScope);
  const cacheKey = `${scopeKey}:${host}`;
  const now = Date.now();

  const cachedToken = incogniaTokenByScopeHost.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const appId = await resolveIncogniaAppIdForUrl({ url: input.url, sessionScope: input.sessionScope });
  if (!appId) return null;

  try {
    const incogniaWebSdk = await getIncogniaWebSdk();
    await ensureIncogniaSdkInitialized(appId);
    const token = await incogniaWebSdk.generateRequestToken({ askForGeolocation: false });
    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    if (!normalizedToken) return null;
    incogniaTokenByScopeHost.set(cacheKey, {
      token: normalizedToken,
      expiresAt: now + INCOGNIA_TOKEN_CACHE_TTL_MS,
    });
    return normalizedToken;
  } catch (error: unknown) {
    warnAutoIncognia('Failed to generate Incognia request token automatically', { err: error });
    return null;
  }
}

async function withAutoIncogniaRequestHeader(input: {
  url: string;
  headers: Record<string, string>;
  sessionScope?: string | undefined;
  requestProfile?: 'default' | 'oauth_token';
}): Promise<Record<string, string>> {
  if (input.requestProfile === 'oauth_token') return input.headers;
  if (readHeaderCaseInsensitive(input.headers, 'x-incognia-request-token')) return input.headers;

  const sessionHeaders = getDynamicHeadersForUrl(input.url, input.sessionScope);
  if (readHeaderCaseInsensitive(sessionHeaders, 'x-incognia-request-token')) return input.headers;

  const token = await resolveAutoIncogniaRequestToken({
    url: input.url,
    sessionScope: input.sessionScope,
  });
  if (!token) return input.headers;

  return { ...input.headers, 'x-incognia-request-token': token };
}

function resolveEnvRequestHeaders(): Record<string, string> {
  const resolved: Record<string, string> = {};

  const incogniaRequestToken = process.env.VINTED_INCOGNIA_REQUEST_TOKEN?.trim();
  if (incogniaRequestToken) {
    resolved['x-incognia-request-token'] = incogniaRequestToken;
  }

  const cookie = process.env.VINTED_COOKIE?.trim();
  if (cookie) {
    resolved.cookie = cookie;
  }

  const anonIdFromEnv = process.env.VINTED_ANON_ID?.trim();
  if (anonIdFromEnv) {
    resolved['x-anon-id'] = anonIdFromEnv;
  } else if (cookie) {
    const anonIdFromCookie = parseCookieHeader(cookie).get('anon_id');
    if (anonIdFromCookie) {
      resolved['x-anon-id'] = anonIdFromCookie;
    }
  }

  const extraHeadersRaw = process.env.VINTED_EXTRA_HEADERS_JSON?.trim();
  if (extraHeadersRaw) {
    try {
      const parsed = JSON.parse(extraHeadersRaw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && key.trim().length > 0) {
            resolved[key] = value;
          }
        }
      }
    } catch (error: unknown) {
      logger.warn({ err: error }, 'Invalid VINTED_EXTRA_HEADERS_JSON; ignoring');
    }
  }

  return resolved;
}

function encodeCookieValue(value: string): string {
  return encodeURIComponent(value.trim());
}

function buildWebSessionCookieHeader(input: {
  accessToken: string;
  refreshToken?: string | undefined;
}): string {
  const cookieParts = [`access_token_web=${encodeCookieValue(input.accessToken)}`];
  const refreshToken = input.refreshToken?.trim();
  if (refreshToken) {
    cookieParts.push(`refresh_token_web=${encodeCookieValue(refreshToken)}`);
  }
  return cookieParts.join('; ');
}

function buildActionAuthHeaders(input: {
  accessToken: string;
  refreshToken?: string | undefined;
  includeAuthorization: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: buildWebSessionCookieHeader({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
    }),
  };
  if (input.includeAuthorization) {
    headers.authorization = `Bearer ${input.accessToken}`;
  }
  return headers;
}

type FetchJsonInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  sessionScope?: string | undefined;
  requestProfile?: 'default' | 'oauth_token';
};

type VintedHttpBackend = 'auto' | 'fetch' | 'curl';

function parseHttpBackendFromEnv(): VintedHttpBackend {
  const raw = process.env.VINTED_HTTP_BACKEND?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'fetch' || raw === 'curl') return raw;
  return 'auto';
}

let preferCurlUntil = 0;

function markPreferCurlFor(ms: number) {
  preferCurlUntil = Date.now() + ms;
}

function shouldPreferCurl(): boolean {
  return Date.now() < preferCurlUntil;
}

export function resetVintedClientRequestStateForTests(): void {
  preferCurlUntil = 0;
  cookieJarByScopeHost.clear();
  dynamicHeadersByScopeHost.clear();
  sessionWarmupByScopeHost.clear();
  incogniaAppIdByHost.clear();
  incogniaTokenByScopeHost.clear();
  incogniaInitPromiseByAppId.clear();
  incogniaWebSdkPromise = null;
  lastIncogniaWarningAt = 0;
}

function resolveUserAgent(): string {
  const envUserAgent = process.env.VINTED_USER_AGENT?.trim();
  if (envUserAgent) return envUserAgent;
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
  );
}

function resolveAcceptLanguage(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.nl')) return 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.de') || host.endsWith('.at')) return 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.fr')) return 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.it')) return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.es')) return 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.pl')) return 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.cz')) return 'cs-CZ,cs;q=0.9,en-US;q=0.8,en;q=0.7';
    if (host.endsWith('.pt')) return 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7';
  } catch {
    // fall through
  }
  return 'en-US,en;q=0.9';
}

function buildRequestHeaders(input: {
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  includeUserAgent?: boolean;
  sessionScope?: string | undefined;
  requestProfile?: 'default' | 'oauth_token';
}): Record<string, string> {
  const { url, headers = {}, body, includeUserAgent = true, sessionScope, requestProfile = 'default' } = input;

  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  })();

  const envHeaders = requestProfile === 'oauth_token' ? {} : resolveEnvRequestHeaders();
  const sessionHeaders = requestProfile === 'oauth_token' ? {} : getDynamicHeadersForUrl(url, sessionScope);
  const explicitCookie = readHeaderCaseInsensitive(headers, 'cookie');
  const sessionCookie = readHeaderCaseInsensitive(sessionHeaders, 'cookie');
  const envCookie = readHeaderCaseInsensitive(envHeaders, 'cookie');
  const jarCookie =
    requestProfile === 'oauth_token' ? undefined : getCookieHeaderFromJar(url, sessionScope);

  const mergedCookie = mergeCookieHeaders([jarCookie, envCookie, sessionCookie, explicitCookie]);
  const mergedCookiesMap = mergedCookie ? parseCookieHeader(mergedCookie) : new Map<string, string>();

  const resolved: Record<string, string> = {
    ...(includeUserAgent ? { 'user-agent': resolveUserAgent() } : {}),
    accept: 'application/json, text/plain, */*',
    'accept-language': resolveAcceptLanguage(url),
    ...(origin ? { origin, referer: `${origin}/` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...envHeaders,
    ...sessionHeaders,
    ...headers,
  };

  if (mergedCookie) {
    setHeaderCaseInsensitive(resolved, 'cookie', mergedCookie);
  }

  if (requestProfile !== 'oauth_token') {
    if (!readHeaderCaseInsensitive(resolved, 'x-requested-with')) {
      setHeaderCaseInsensitive(resolved, 'x-requested-with', 'XMLHttpRequest');
    }

    const anonId =
      readHeaderCaseInsensitive(headers, 'x-anon-id') ??
      readHeaderCaseInsensitive(sessionHeaders, 'x-anon-id') ??
      readHeaderCaseInsensitive(envHeaders, 'x-anon-id') ??
      mergedCookiesMap.get('anon_id');
    if (anonId) {
      setHeaderCaseInsensitive(resolved, 'x-anon-id', anonId);
    }

    const vUdt =
      readHeaderCaseInsensitive(headers, 'x-v-udt') ??
      readHeaderCaseInsensitive(sessionHeaders, 'x-v-udt') ??
      mergedCookiesMap.get('v_udt');
    if (vUdt) {
      setHeaderCaseInsensitive(resolved, 'x-v-udt', vUdt);
    }

    const csrfToken =
      readHeaderCaseInsensitive(headers, 'x-csrf-token') ??
      readHeaderCaseInsensitive(sessionHeaders, 'x-csrf-token') ??
      readHeaderCaseInsensitive(envHeaders, 'x-csrf-token') ??
      DEFAULT_CSRF_TOKEN;
    if (csrfToken) {
      setHeaderCaseInsensitive(resolved, 'x-csrf-token', csrfToken);
    }

    const priority =
      readHeaderCaseInsensitive(headers, 'priority') ??
      readHeaderCaseInsensitive(sessionHeaders, 'priority') ??
      readHeaderCaseInsensitive(envHeaders, 'priority') ??
      'u=3';
    if (priority) {
      setHeaderCaseInsensitive(resolved, 'priority', priority);
    }
  }

  return resolved;
}

function shouldWarmupSession(): boolean {
  const raw = process.env.VINTED_SESSION_WARMUP?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  return process.env.NODE_ENV !== 'test';
}

async function warmupHostSession(input: {
  baseUrl: string;
  sessionScope?: string | undefined;
}): Promise<void> {
  if (!shouldWarmupSession()) return;

  const scopeKey = normalizeSessionScope(input.sessionScope);
  const host = resolveHostFromUrl(input.baseUrl);
  if (!host) return;

  const cacheKey = `${scopeKey}:${host}`;
  const now = Date.now();
  const lastWarmup = sessionWarmupByScopeHost.get(cacheKey);
  if (lastWarmup && now - lastWarmup < SESSION_WARMUP_TTL_MS) return;
  sessionWarmupByScopeHost.set(cacheKey, now);

  const url = `${input.baseUrl}/`;
  const headers = buildRequestHeaders({ url, includeUserAgent: true, sessionScope: scopeKey });
  const response = await fetch(url, { method: 'GET', headers }).catch((error: unknown) => {
    logger.debug({ err: error, url }, 'Vinted session warmup request failed');
    return null;
  });
  if (!response) return;

  const setCookieHeaders = getSetCookieHeaders(response.headers);
  if (setCookieHeaders.length > 0) {
    setCookiesInJar(url, setCookieHeaders, scopeKey);
  }
  rememberResponseHeadersForSession({ url, headers: response.headers, sessionScope: scopeKey });

  await response.arrayBuffer().catch(() => undefined);
}

function looksLikeBotBlock(status: number, contentType: string | null, text: string): boolean {
  if (status !== 403) return false;
  if (contentType?.toLowerCase().includes('text/html')) return true;
  const lower = text.toLowerCase();
  return lower.includes('<!doctype html') || lower.includes('<title>vinted</title') || lower.includes('just a moment');
}

function toVintedBlockedError(): VintedError {
  return toVintedError(
    'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz und versuche es später erneut.',
  );
}

function isInvalidGrantError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('invalid_grant') || lower.includes('authorization grant is invalid');
}

async function fetchJsonViaCurl(input: FetchJsonInput): Promise<Result<unknown, VintedError>> {
  const { url, method = 'GET', headers = {}, body, sessionScope, requestProfile = 'default' } = input;
  const headersWithIncognia = await withAutoIncogniaRequestHeader({
    url,
    headers,
    sessionScope,
    requestProfile,
  });

  const effectiveHeaders = buildRequestHeaders({
    url,
    headers: headersWithIncognia,
    body,
    includeUserAgent: false,
    sessionScope,
    requestProfile,
  });

  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args: string[] = [
    '--silent',
    '--show-error',
    '--location',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    '--request',
    method,
    '--write-out',
    '\n%{http_code}',
    url,
  ];

  for (const [k, v] of Object.entries(effectiveHeaders)) {
    if (k.toLowerCase() === 'user-agent') continue; // triggers CF challenge for curl
    args.push('--header', `${k}: ${v}`);
  }

  if (body !== undefined) {
    args.push('--data-raw', JSON.stringify(body));
  }

  const child = spawn(curlCmd, args, { windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += String(d);
  });
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('error', (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      stderr += msg ? `\n${msg}` : '';
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const msg = stderr.trim();
    return err(
      toVintedError(
        `Curl request failed (exit ${exitCode}). ${msg ? msg.slice(0, 200) : 'No stderr.'}`,
      ),
    );
  }

  const lastNewline = stdout.lastIndexOf('\n');
  if (lastNewline === -1) return err(toVintedError('Curl response missing status code.'));

  const statusText = stdout.slice(lastNewline + 1).trim();
  const status = Number.parseInt(statusText, 10);
  const text = stdout.slice(0, lastNewline);
  if (!Number.isFinite(status)) return err(toVintedError('Curl returned invalid status code.'));

  if (status < 200 || status >= 300) {
    if (looksLikeBotBlock(status, null, text)) return err(toVintedBlockedError());
    return err(
      toVintedError(
        `Vinted request failed (${status}). ${text.slice(0, 200).trim() || 'No body.'}`,
      ),
    );
  }

  try {
    return ok(JSON.parse(text));
  } catch {
    return err(toVintedError('Failed to parse Vinted response.'));
  }
}

async function fetchJson(input: FetchJsonInput): Promise<Result<unknown, VintedError>> {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    sessionScope,
    requestProfile = 'default',
  } = input;
  const headersWithIncognia = await withAutoIncogniaRequestHeader({
    url,
    headers,
    sessionScope,
    requestProfile,
  });
  const normalizedInput: FetchJsonInput = {
    ...input,
    headers: headersWithIncognia,
  };

  const backend = parseHttpBackendFromEnv();
  if (backend === 'curl' || (backend === 'auto' && shouldPreferCurl())) {
    return fetchJsonViaCurl(normalizedInput);
  }

  const requestInit: RequestInit = {
    method,
    headers: buildRequestHeaders({
      url,
      headers: headersWithIncognia,
      body,
      includeUserAgent: true,
      sessionScope,
      requestProfile,
    }),
  };
  const requestHeaders = requestInit.headers as Record<string, string>;
  const requestCookieHeader = readHeaderCaseInsensitive(requestHeaders, 'cookie');
  const requestCookies = requestCookieHeader ? parseCookieHeader(requestCookieHeader) : new Map<string, string>();
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  const res = await fetch(url, requestInit).catch((e: unknown) => {
    logger.warn({ err: e }, 'Vinted fetch failed; falling back to curl');
    return null;
  });
  if (!res) {
    markPreferCurlFor(30 * 60 * 1000);
    return fetchJsonViaCurl(normalizedInput);
  }

  const setCookieHeaders = getSetCookieHeaders(res.headers);
  if (setCookieHeaders.length > 0) {
    setCookiesInJar(url, setCookieHeaders, sessionScope);
  }
  rememberResponseHeadersForSession({ url, headers: res.headers, sessionScope });

  const text = await res.text();
  if (!res.ok) {
    if (backend === 'auto' && (res.status === 401 || res.status === 403)) {
      logger.warn(
        {
          status: res.status,
          method,
          url,
          hasCookieHeader: Boolean(requestCookieHeader),
          hasAnonCookie: requestCookies.has('anon_id'),
          hasVudtCookie: requestCookies.has('v_udt'),
          hasAccessTokenCookie: requestCookies.has('access_token_web'),
          hasRefreshTokenCookie: requestCookies.has('refresh_token_web'),
          hasAnonHeader: Boolean(readHeaderCaseInsensitive(requestHeaders, 'x-anon-id')),
          hasVudtHeader: Boolean(readHeaderCaseInsensitive(requestHeaders, 'x-v-udt')),
          hasCsrfHeader: Boolean(readHeaderCaseInsensitive(requestHeaders, 'x-csrf-token')),
          hasIncogniaHeader: Boolean(readHeaderCaseInsensitive(requestHeaders, 'x-incognia-request-token')),
        },
        'Vinted fetch returned auth/forbidden; retrying via curl backend',
      );
      const retryViaCurl = await fetchJsonViaCurl(normalizedInput);
      if (retryViaCurl.isOk()) {
        if (res.status === 403) {
          markPreferCurlFor(30 * 60 * 1000);
        }
        return retryViaCurl;
      }
    }

    if (backend === 'auto' && looksLikeBotBlock(res.status, res.headers.get('content-type'), text)) {
      markPreferCurlFor(30 * 60 * 1000);
      return fetchJsonViaCurl(normalizedInput);
    }
    if (looksLikeBotBlock(res.status, res.headers.get('content-type'), text)) {
      return err(toVintedBlockedError());
    }
    return err(
      toVintedError(
        `Vinted request failed (${res.status}). ${text.slice(0, 200).trim() || 'No body.'}`,
      ),
    );
  }

  try {
    return ok(JSON.parse(text));
  } catch {
    return err(toVintedError('Failed to parse Vinted response.'));
  }
}

function parseUpdatedAtFromItem(raw: any): Date | null {
  const timestamps: number[] = [];
  const photoTs = raw?.photo?.high_resolution?.timestamp;
  if (typeof photoTs === 'number') timestamps.push(photoTs);
  const photos = Array.isArray(raw?.photos) ? raw.photos : [];
  for (const p of photos) {
    const ts = p?.high_resolution?.timestamp;
    if (typeof ts === 'number') timestamps.push(ts);
  }
  if (timestamps.length === 0) return null;
  const max = Math.max(...timestamps);
  return new Date(max * 1000);
}

function parseCatalogItem(raw: any): VintedCatalogItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id;
  if (typeof id !== 'number') return null;

  const url = typeof raw.url === 'string' ? raw.url : null;
  if (!url) return null;

  const user = raw.user;
  const userId = user?.id;
  const userLogin = user?.login;
  const profileUrl = user?.profile_url;
  if (
    typeof userId !== 'number' ||
    typeof userLogin !== 'string' ||
    typeof profileUrl !== 'string'
  ) {
    return null;
  }

  const price = raw.price;
  if (typeof price?.amount !== 'string' || typeof price?.currency_code !== 'string') return null;

  return {
    id: BigInt(id),
    title: typeof raw.title === 'string' ? raw.title : 'Ohne Titel',
    url,
    price: { amount: price.amount, currency_code: price.currency_code },
    size_title: typeof raw.size_title === 'string' ? raw.size_title : '',
    status: typeof raw.status === 'string' ? raw.status : '',
    photoUrl: typeof raw.photo?.url === 'string' ? raw.photo.url : null,
    updatedAt: parseUpdatedAtFromItem(raw),
    user: { id: userId, login: userLogin, profile_url: profileUrl },
  };
}

function parseCheckoutUrl(input: {
  baseUrl: string;
  itemId: bigint;
  payload: unknown;
}): string | null {
  const raw = input.payload as any;

  const directUrlCandidates = [
    raw?.checkout_url,
    raw?.checkoutUrl,
    raw?.checkout?.checkout_url,
    raw?.checkout?.checkoutUrl,
    raw?.checkout?.url,
    raw?.checkout?.web_url,
    raw?.checkout?.webUrl,
    raw?.purchase?.checkout_url,
    raw?.purchase?.checkoutUrl,
    raw?.purchase?.url,
    raw?.next_step?.url,
    raw?.nextStep?.url,
    raw?.payment?.checkout_url,
    raw?.payment?.checkoutUrl,
    raw?.payment?.url,
    raw?.url,
  ];

  for (const candidate of directUrlCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return normalizeCheckoutUrlCandidate(input.baseUrl, candidate);
    }
  }

  const nestedCheckoutUrl = findNestedCheckoutUrl(raw);
  if (nestedCheckoutUrl) {
    return normalizeCheckoutUrlCandidate(input.baseUrl, nestedCheckoutUrl);
  }

  const purchaseId = extractPurchaseIdFromCheckoutPayload(raw);
  if (purchaseId !== null) {
    const params = new URLSearchParams({
      purchase_id: purchaseId.toString(),
      order_id: input.itemId.toString(),
      order_type: 'transaction',
    });
    return `${input.baseUrl}/checkout?${params.toString()}`;
  }

  return null;
}

function parseBigintCandidate(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeCheckoutUrlCandidate(baseUrl: string, candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return trimmed;

  try {
    return new URL(trimmed, `${baseUrl}/`).toString();
  } catch {
    return trimmed;
  }
}

function looksLikeCheckoutUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('/checkout') || lower.includes('purchase_id=');
}

function findNestedCheckoutUrl(
  value: unknown,
  depth = 6,
  seen: Set<unknown> = new Set(),
): string | null {
  if (depth < 0 || value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 && looksLikeCheckoutUrl(trimmed) ? trimmed : null;
  }

  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedCheckoutUrl(entry, depth - 1, seen);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      if (
        normalizedKey === 'checkout_url' ||
        normalizedKey === 'checkouturl' ||
        normalizedKey === 'redirect_url' ||
        normalizedKey === 'redirecturl' ||
        normalizedKey === 'payment_url' ||
        normalizedKey === 'paymenturl' ||
        normalizedKey === 'web_url' ||
        normalizedKey === 'weburl' ||
        normalizedKey === 'checkout_link' ||
        normalizedKey === 'checkoutlink'
      ) {
        return trimmed;
      }

      if (normalizedKey === 'url' && looksLikeCheckoutUrl(trimmed)) {
        return trimmed;
      }
    }

    const nested = findNestedCheckoutUrl(entry, depth - 1, seen);
    if (nested) return nested;
  }

  return null;
}

function findNestedPurchaseId(
  value: unknown,
  parentKey: string | null = null,
  depth = 6,
  seen: Set<unknown> = new Set(),
): bigint | null {
  if (depth < 0 || value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedPurchaseId(entry, parentKey, depth - 1, seen);
      if (nested !== null) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();

    if (
      normalizedKey === 'purchase_id' ||
      normalizedKey === 'purchaseid' ||
      normalizedKey === 'checkout_id' ||
      normalizedKey === 'checkoutid'
    ) {
      const parsed = parseBigintCandidate(entry);
      if (parsed !== null) return parsed;
    }

    if (normalizedKey === 'id' && (parentKey === 'purchase' || parentKey === 'checkout')) {
      const parsed = parseBigintCandidate(entry);
      if (parsed !== null) return parsed;
    }

    const nested = findNestedPurchaseId(entry, normalizedKey, depth - 1, seen);
    if (nested !== null) return nested;
  }

  return null;
}

function extractPurchaseIdFromCheckoutPayload(payload: unknown): bigint | null {
  const raw = payload as any;
  return (
    parseBigintCandidate(raw?.checkout?.id) ??
    parseBigintCandidate(raw?.checkout?.purchase_id) ??
    parseBigintCandidate(raw?.checkout?.purchase?.id) ??
    parseBigintCandidate(raw?.checkout_id) ??
    parseBigintCandidate(raw?.purchase_id) ??
    parseBigintCandidate(raw?.purchase?.id) ??
    parseBigintCandidate(raw?.purchase?.purchase_id) ??
    findNestedPurchaseId(raw) ??
    parseBigintCandidate(raw?.id) ??
    null
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function pickBoolean(input: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function pickUnknown(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(input, key)) return input[key];
  }
  return undefined;
}

function extractCheckoutComponentsPayload(payload: unknown): Record<string, unknown> | null {
  const raw = payload as any;
  const candidates = [
    asRecord(raw?.components),
    asRecord(raw?.checkout?.components),
    asRecord(raw?.checkout_data?.components),
  ];

  for (const source of candidates) {
    if (!source) continue;

    const normalized: Record<string, unknown> = {};

    const itemPresentationEscrow = asRecord(source.item_presentation_escrow_v2);
    if (itemPresentationEscrow) {
      const itemsToRemove = pickUnknown(itemPresentationEscrow, ['items_to_remove', 'itemsToRemove']);
      if (itemsToRemove !== undefined) {
        normalized.item_presentation_escrow_v2 = { items_to_remove: itemsToRemove };
      }
    }

    const additionalService = asRecord(source.additional_service);
    if (additionalService) {
      const isSelected = pickBoolean(additionalService, ['is_selected', 'isSelected']);
      const type = pickString(additionalService, ['type']);
      if (isSelected !== null || type !== null) {
        normalized.additional_service = {
          ...(isSelected !== null ? { is_selected: isSelected } : {}),
          ...(type !== null ? { type } : {}),
        };
      }
    }

    const paymentMethod = asRecord(source.payment_method);
    if (paymentMethod) {
      const cardId = pickString(paymentMethod, ['card_id', 'cardId']);
      const methodId = pickString(paymentMethod, ['pay_in_method_id', 'method_id', 'methodId', 'payInMethodId']);
      if (cardId !== null || methodId !== null) {
        normalized.payment_method = {
          ...(cardId !== null ? { card_id: cardId } : {}),
          ...(methodId !== null ? { pay_in_method_id: methodId } : {}),
        };
      }
    }

    const shippingAddress = asRecord(source.shipping_address);
    if (shippingAddress) {
      const userId = pickString(shippingAddress, ['user_id', 'userId']);
      const shippingAddressId = pickString(shippingAddress, ['shipping_address_id', 'shippingAddressId']);
      if (userId !== null || shippingAddressId !== null) {
        normalized.shipping_address = {
          ...(userId !== null ? { user_id: userId } : {}),
          ...(shippingAddressId !== null ? { shipping_address_id: shippingAddressId } : {}),
        };
      }
    }

    const pickupOptions = asRecord(source.shipping_pickup_options);
    if (pickupOptions) {
      const pickupType = pickString(pickupOptions, ['pickup_type', 'pickupType']);
      if (pickupType !== null) {
        normalized.shipping_pickup_options = { pickup_type: pickupType };
      }
    }

    const pickupDetails = asRecord(source.shipping_pickup_details);
    if (pickupDetails) {
      const rateUuid = pickString(pickupDetails, ['rate_uuid', 'rateUuid']);
      const pointCode = pickString(pickupDetails, ['point_code', 'pointCode']);
      const pointUuid = pickString(pickupDetails, ['point_uuid', 'pointUuid']);
      if (rateUuid !== null || pointCode !== null || pointUuid !== null) {
        normalized.shipping_pickup_details = {
          ...(rateUuid !== null ? { rate_uuid: rateUuid } : {}),
          ...(pointCode !== null ? { point_code: pointCode } : {}),
          ...(pointUuid !== null ? { point_uuid: pointUuid } : {}),
        };
      }
    }

    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  return null;
}

function isCheckoutPurchaseCompleted(payload: unknown): boolean {
  const raw = payload as any;

  if (raw?.has_bought === true || raw?.checkout?.has_bought === true) return true;
  if (raw?.paid === true || raw?.checkout?.paid === true) return true;
  if (raw?.purchase_success === true || raw?.checkout_success === true) return true;
  if (raw?.success_payment_navigation || raw?.successPaymentNavigation) return true;

  const statusCandidates = [
    raw?.status,
    raw?.checkout?.status,
    raw?.purchase?.status,
    raw?.payment_status,
    raw?.checkout?.payment_status,
    raw?.checkout?.state,
  ];

  for (const value of statusCandidates) {
    if (typeof value !== 'string') continue;
    const normalized = value.toLowerCase();
    if (
      normalized.includes('success') ||
      normalized.includes('paid') ||
      normalized.includes('complete') ||
      normalized.includes('finished')
    ) {
      return true;
    }
  }

  return false;
}

function shouldPrimeCheckoutSessionFromError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('(403)') ||
    lower.includes('cloudflare') ||
    lower.includes('captcha') ||
    lower.includes('blockiert') ||
    lower.includes('access_denied')
  );
}

export class VintedClient {
  async createConversationTransaction(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    sellerUserId: number;
    sessionKey?: string;
  }): Promise<Result<{ transactionId: bigint }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const url = `${baseUrl}/api/v2/conversations`;
    const body = {
      initiator: 'buyer_enters_offer_form',
      item_id: Number(input.itemId),
      opposite_user_id: input.sellerUserId,
    };

    const primaryJson = await fetchJson({
      url,
      method: 'POST',
      headers: buildActionAuthHeaders({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        includeAuthorization: false,
      }),
      body,
      sessionScope: input.sessionKey,
    });
    const json =
      primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
        ? await fetchJson({
            url,
            method: 'POST',
            headers: buildActionAuthHeaders({
              accessToken: input.accessToken,
              refreshToken: input.refreshToken,
              includeAuthorization: true,
            }),
            body,
            sessionScope: input.sessionKey,
          })
        : primaryJson;

    if (json.isErr()) return err(json.error);

    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));

    const payload = json.value as Record<string, unknown>;
    const conversation =
      payload && typeof payload.conversation === 'object'
        ? (payload.conversation as Record<string, unknown>)
        : undefined;
    const transaction =
      payload && typeof payload.transaction === 'object'
        ? (payload.transaction as Record<string, unknown>)
        : undefined;
    const conversationTransaction =
      conversation && typeof conversation.transaction === 'object'
        ? (conversation.transaction as Record<string, unknown>)
        : undefined;

    const transactionIdCandidate =
      parseBigintCandidate(conversationTransaction?.id) ??
      parseBigintCandidate(conversation?.transaction_id) ??
      parseBigintCandidate(transaction?.id) ??
      parseBigintCandidate(payload.transaction_id) ??
      parseBigintCandidate(payload.transactionId);

    if (!transactionIdCandidate) {
      logger.info(
        {
          itemId: input.itemId.toString(),
          sellerUserId: input.sellerUserId,
          region: input.region,
          topLevelKeys: Object.keys(payload).slice(0, 20),
        },
        'Conversation response missing transaction id',
      );
      return err(toVintedError('Conversation created but transaction id missing.'));
    }

    return ok({ transactionId: transactionIdCandidate });
  }

  async refreshToken(input: {
    region: VintedRegion;
    refreshToken: string;
    sessionKey?: string;
  }): Promise<Result<VintedTokenResponse, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    const url = `${baseUrl}/oauth/token`;

    let lastErrorMessage: string | null = null;

    const res = await pRetry(
      async () => {
        const json = await fetchJson({
          url,
          method: 'POST',
          sessionScope: input.sessionKey,
          requestProfile: 'oauth_token',
          body: {
            client_id: 'web',
            scope: 'user',
            grant_type: 'refresh_token',
            refresh_token: input.refreshToken,
          },
        });
        if (json.isErr()) {
          lastErrorMessage = json.error.message;
          if (
            json.error.message.toLowerCase().includes('blockiert') ||
            isInvalidGrantError(json.error.message)
          ) {
            throw new AbortError(json.error.message);
          }
          throw new Error(json.error.message);
        }
        return json.value;
      },
      { retries: 2 },
    ).catch((e: unknown) => {
      logger.warn({ err: e }, 'Vinted token refresh failed');
      if (e instanceof Error) lastErrorMessage = e.message;
      return null;
    });

    if (!res) {
      return err(toVintedError(lastErrorMessage ?? 'Failed to refresh Vinted token.'));
    }

    const payloadError = extractErrorsPayloadMessage(res);
    if (payloadError) {
      return err(toVintedError(payloadError));
    }

    const accessToken = (res as any).access_token;
    const refreshToken = (res as any).refresh_token;
    const expiresIn = (res as any).expires_in;
    const createdAt = (res as any).created_at;
    if (
      typeof accessToken !== 'string' ||
      typeof refreshToken !== 'string' ||
      typeof expiresIn !== 'number' ||
      typeof createdAt !== 'number'
    ) {
      return err(toVintedError('Unexpected token response from Vinted.'));
    }

    return ok({ accessToken, refreshToken, expiresIn, createdAt });
  }

  async searchCatalog(input: {
    region: VintedRegion;
    accessToken: string;
    searchUrl: string;
    page?: number;
    perPage?: number;
    sessionKey?: string;
  }): Promise<Result<VintedCatalogItem[], VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    let parsed: URL;
    try {
      parsed = new URL(input.searchUrl);
    } catch {
      return err(toVintedError('Invalid search URL.'));
    }

    const qp = new URLSearchParams(parsed.searchParams);

    const catalogFilters = qp.getAll('catalog[]');
    if (catalogFilters.length > 0) {
      qp.delete('catalog[]');
      for (const catalogId of catalogFilters) {
        qp.append('catalog_ids[]', catalogId);
      }
    }

    qp.set('page', String(input.page ?? 1));
    qp.set('per_page', String(input.perPage ?? 20));
    qp.set('order', qp.get('order') ?? 'newest_first');

    const url = `${baseUrl}/api/v2/catalog/items?${qp.toString()}`;

    const json = await fetchJson({
      url,
      headers: { authorization: `Bearer ${input.accessToken}` },
      sessionScope: input.sessionKey,
    });
    if (json.isErr()) return err(json.error);
    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));

    const items = (json.value as any).items;
    if (!Array.isArray(items)) return err(toVintedError('Unexpected catalog response.'));

    const parsedItems = items.map(parseCatalogItem).filter((x): x is VintedCatalogItem => x !== null);
    return ok(parsedItems);
  }

  async getUser(input: {
    region: VintedRegion;
    accessToken: string;
    userId: number;
    sessionKey?: string;
  }): Promise<Result<VintedUser, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    const url = `${baseUrl}/api/v2/users/${input.userId}`;

    const json = await fetchJson({
      url,
      headers: { authorization: `Bearer ${input.accessToken}` },
      sessionScope: input.sessionKey,
    });
    if (json.isErr()) return err(json.error);
    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));

    const user = (json.value as any).user;
    if (!user || typeof user !== 'object') {
      return err(toVintedError('Unexpected user response.'));
    }

    const feedbackReputation =
      typeof user.feedback_reputation === 'number' ? user.feedback_reputation : null;
    const feedbackCount = typeof user.feedback_count === 'number' ? user.feedback_count : null;

    return ok({
      id: typeof user.id === 'number' ? user.id : input.userId,
      login: typeof user.login === 'string' ? user.login : String(input.userId),
      feedbackReputation,
      feedbackCount,
    });
  }

  async toggleFavourite(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    sessionKey?: string;
  }): Promise<Result<{ liked: boolean; known: boolean }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const url = `${baseUrl}/api/v2/user_favourites/toggle`;

    const primaryJson = await fetchJson({
      url,
      method: 'POST',
      headers: buildActionAuthHeaders({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        includeAuthorization: false,
      }),
      body: { type: 'item', user_favourites: [Number(input.itemId)] },
      sessionScope: input.sessionKey,
    });
    const json =
      primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
        ? await fetchJson({
            url,
            method: 'POST',
            headers: buildActionAuthHeaders({
              accessToken: input.accessToken,
              refreshToken: input.refreshToken,
              includeAuthorization: true,
            }),
            body: { type: 'item', user_favourites: [Number(input.itemId)] },
            sessionScope: input.sessionKey,
          })
        : primaryJson;
    if (json.isErr()) return err(json.error);
    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));

    const payload = json.value as any;
    const booleanCandidates: unknown[] = [
      payload?.item?.is_favourite,
      payload?.item?.isFavorite,
      payload?.user_favourites?.[0]?.is_favourite,
      payload?.user_favourites?.[0]?.isFavorite,
      payload?.is_favourite,
      payload?.isFavorite,
      payload?.favourited,
      payload?.favorited,
    ];

    for (const candidate of booleanCandidates) {
      if (typeof candidate === 'boolean') {
        return ok({ liked: candidate, known: true });
      }
    }

    const actionCandidate = [payload?.action, payload?.result, payload?.status]
      .find((value) => typeof value === 'string')
      ?.toLowerCase();

    if (actionCandidate) {
      if (actionCandidate.includes('add') || actionCandidate.includes('favourit') || actionCandidate.includes('favorit')) {
        return ok({ liked: true, known: true });
      }
      if (actionCandidate.includes('remove') || actionCandidate.includes('unfavourit') || actionCandidate.includes('unfavorit')) {
        return ok({ liked: false, known: true });
      }
    }

    logger.info(
      {
        itemId: input.itemId.toString(),
        region: input.region,
        topLevelKeys:
          payload && typeof payload === 'object'
            ? Object.keys(payload as Record<string, unknown>).slice(0, 20)
            : [],
      },
      'Favourite toggle response missing explicit favourite state',
    );

    return ok({ liked: false, known: false });
  }

  async buildCheckout(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    pickupPoint?: string | null;
    sessionKey?: string;
  }): Promise<Result<{ checkoutUrl: string | null }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const url = `${baseUrl}/api/v2/purchases/checkout/build`;
    const requestBody = {
      purchase_items: [{ id: Number(input.itemId), type: 'transaction' }],
      pickup_point: input.pickupPoint ?? undefined,
    };

    const executeBuildCheckout = async (includeAuthorization: boolean) =>
      fetchJson({
        url,
        method: 'POST',
        headers: buildActionAuthHeaders({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          includeAuthorization,
        }),
        body: requestBody,
        sessionScope: input.sessionKey,
      });

    const primaryJson = await executeBuildCheckout(false);
    let json =
      primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
        ? await executeBuildCheckout(true)
        : primaryJson;

    if (json.isErr() && shouldPrimeCheckoutSessionFromError(json.error.message)) {
      const preflightUrl = `${baseUrl}/api/v2/catalog/items?page=1&per_page=1&order=newest_first`;
      await fetchJson({
        url: preflightUrl,
        headers: { authorization: `Bearer ${input.accessToken}` },
        sessionScope: input.sessionKey,
      });
      json = await executeBuildCheckout(true);
    }

    if (json.isErr()) {
      if (json.error.message.includes('captcha-delivery.com')) {
        return ok({ checkoutUrl: null });
      }
      return err(json.error);
    }
    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));
    const purchaseId = extractPurchaseIdFromCheckoutPayload(json.value);

    const checkoutUrl = parseCheckoutUrl({
      baseUrl,
      itemId: input.itemId,
      payload: json.value,
    });

    if (!checkoutUrl) {
      const value = json.value;
      const keys =
        value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
      logger.info(
        {
          itemId: input.itemId.toString(),
          region: input.region,
          purchaseId: purchaseId?.toString() ?? null,
          topLevelKeys: keys.slice(0, 20),
        },
        'Checkout build response missing checkout url/purchase id',
      );
    }

    return ok({ checkoutUrl });
  }

  async submitCheckoutPurchase(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    purchaseId: bigint;
    sessionKey?: string;
  }): Promise<Result<{ purchased: boolean }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const url = `${baseUrl}/api/v2/purchases/${input.purchaseId.toString()}/checkout`;

    const sendCheckoutUpdate = async (
      body: Record<string, unknown>,
    ): Promise<Result<unknown, VintedError>> => {
      const primaryJson = await fetchJson({
        url,
        method: 'PUT',
        headers: buildActionAuthHeaders({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          includeAuthorization: false,
        }),
        body,
        sessionScope: input.sessionKey,
      });
      const json =
        primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
          ? await fetchJson({
              url,
              method: 'PUT',
              headers: buildActionAuthHeaders({
                accessToken: input.accessToken,
                refreshToken: input.refreshToken,
                includeAuthorization: true,
              }),
              body,
              sessionScope: input.sessionKey,
            })
          : primaryJson;

      if (json.isErr()) return err(json.error);
      const payloadError = extractErrorsPayloadMessage(json.value);
      if (payloadError) return err(toVintedError(payloadError));
      return ok(json.value);
    };

    const firstAttempt = await sendCheckoutUpdate({ components: [] });
    if (firstAttempt.isErr()) return err(firstAttempt.error);
    if (isCheckoutPurchaseCompleted(firstAttempt.value)) {
      return ok({ purchased: true });
    }

    const components = extractCheckoutComponentsPayload(firstAttempt.value);
    if (!components) {
      logger.info(
        {
          purchaseId: input.purchaseId.toString(),
          region: input.region,
          topLevelKeys:
            firstAttempt.value && typeof firstAttempt.value === 'object'
              ? Object.keys(firstAttempt.value as Record<string, unknown>).slice(0, 20)
              : [],
        },
        'Checkout submit response did not provide reusable checkout components',
      );
      return ok({ purchased: false });
    }

    const secondAttempt = await sendCheckoutUpdate({ components });
    if (secondAttempt.isErr()) return err(secondAttempt.error);

    if (isCheckoutPurchaseCompleted(secondAttempt.value)) {
      return ok({ purchased: true });
    }

    logger.info(
      {
        purchaseId: input.purchaseId.toString(),
        region: input.region,
        topLevelKeys:
          secondAttempt.value && typeof secondAttempt.value === 'object'
            ? Object.keys(secondAttempt.value as Record<string, unknown>).slice(0, 20)
            : [],
      },
      'Checkout submit finished without purchase confirmation',
    );

    return ok({ purchased: false });
  }

  async estimateOfferWithFees(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    amount: number;
    currencyCode: string;
    sessionKey?: string;
  }): Promise<Result<{ total: string; serviceFee: string | null }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const url = `${baseUrl}/api/v2/offer/estimate_with_fees`;

    const primaryJson = await fetchJson({
      url,
      method: 'POST',
      headers: buildActionAuthHeaders({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        includeAuthorization: false,
      }),
      body: {
        item_id: input.itemId.toString(),
        amount: {
          amount: input.amount.toFixed(2),
          currency_code: input.currencyCode,
        },
      },
      sessionScope: input.sessionKey,
    });
    const json =
      primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
        ? await fetchJson({
            url,
            method: 'POST',
            headers: buildActionAuthHeaders({
              accessToken: input.accessToken,
              refreshToken: input.refreshToken,
              includeAuthorization: true,
            }),
            body: {
              item_id: input.itemId.toString(),
              amount: {
                amount: input.amount.toFixed(2),
                currency_code: input.currencyCode,
              },
            },
            sessionScope: input.sessionKey,
          })
        : primaryJson;

    if (json.isErr()) return err(json.error);
    const payloadError = extractErrorsPayloadMessage(json.value);
    if (payloadError) return err(toVintedError(payloadError));

    const total = (json.value as any).total_item_price?.amount;
    const fee = (json.value as any).service_fee?.amount ?? null;
    if (typeof total !== 'string') {
      return err(toVintedError('Unexpected offer estimate response.'));
    }

    return ok({ total, serviceFee: typeof fee === 'string' ? fee : null });
  }

  async sendOffer(input: {
    region: VintedRegion;
    accessToken: string;
    refreshToken?: string;
    itemId: bigint;
    amount: number;
    currencyCode: string;
    sessionKey?: string;
  }): Promise<Result<{ sent: true }, VintedError>> {
    const baseUrl = baseUrlForRegion(input.region);
    await warmupHostSession({ baseUrl, sessionScope: input.sessionKey });
    const amount = input.amount.toFixed(2);

    const sendOfferRequest = async (request: {
      url: string;
      body: unknown;
    }): Promise<Result<{ sent: true }, VintedError>> => {
      const primaryJson = await fetchJson({
        url: request.url,
        method: 'POST',
        headers: buildActionAuthHeaders({
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          includeAuthorization: false,
        }),
        body: request.body,
        sessionScope: input.sessionKey,
      });
      const json =
        primaryJson.isErr() && shouldRetryWithAuthorization(primaryJson.error.message)
          ? await fetchJson({
              url: request.url,
              method: 'POST',
              headers: buildActionAuthHeaders({
                accessToken: input.accessToken,
                refreshToken: input.refreshToken,
                includeAuthorization: true,
              }),
              body: request.body,
              sessionScope: input.sessionKey,
            })
          : primaryJson;

      if (json.isErr()) return err(json.error);
      const payloadError = extractErrorsPayloadMessage(json.value);
      if (payloadError) return err(toVintedError(payloadError));
      return ok({ sent: true });
    };

    const modernEndpointAttempt = await sendOfferRequest({
      url: `${baseUrl}/api/v2/transactions/${input.itemId.toString()}/offer_requests`,
      body: {
        offer_request: {
          price: input.amount,
          currency: input.currencyCode,
        },
      },
    });
    if (modernEndpointAttempt.isOk()) return modernEndpointAttempt;

    logger.info(
      {
        itemId: input.itemId.toString(),
        region: input.region,
      },
      'Modern offer_requests endpoint failed; retrying alternative offer endpoints',
    );

    const transactionOffersAttempt = await sendOfferRequest({
      url: `${baseUrl}/api/v2/transactions/${input.itemId.toString()}/offers`,
      body: {
        offer: {
          price: input.amount,
          currency: input.currencyCode,
        },
      },
    });
    if (transactionOffersAttempt.isOk()) return transactionOffersAttempt;

    logger.info(
      {
        itemId: input.itemId.toString(),
        region: input.region,
      },
      'Transactions offers endpoint failed; retrying legacy offer endpoint',
    );

    const legacyEndpointAttempt = await sendOfferRequest({
      url: `${baseUrl}/api/v2/offers`,
      body: {
        item_id: input.itemId.toString(),
        amount: {
          amount,
          currency_code: input.currencyCode,
        },
      },
    });
    if (legacyEndpointAttempt.isOk()) return legacyEndpointAttempt;

    const modernMessage = modernEndpointAttempt.error.message.toLowerCase();
    const transactionMessage = transactionOffersAttempt.error.message.toLowerCase();
    const legacyMessage = legacyEndpointAttempt.error.message.toLowerCase();
    const endpointMessages = [modernMessage, transactionMessage, legacyMessage];
    const hasSpecificAccessDeniedSignal = endpointMessages.some((message) =>
      message.includes('access_denied'),
    );
    const hasSpecificBlockSignal = endpointMessages.some(
      (message) =>
        message.includes('cloudflare') || message.includes('captcha') || message.includes('blockiert'),
    );
    const modernLooksMoreSpecific =
      modernMessage.includes('access_denied') ||
      modernMessage.includes('cloudflare') ||
      modernMessage.includes('captcha') ||
      modernMessage.includes('blockiert');
    const transactionLooksMoreSpecific =
      transactionMessage.includes('access_denied') ||
      transactionMessage.includes('cloudflare') ||
      transactionMessage.includes('captcha') ||
      transactionMessage.includes('blockiert');

    if (modernLooksMoreSpecific && !legacyMessage.includes('access_denied')) {
      return err(modernEndpointAttempt.error);
    }
    if (transactionLooksMoreSpecific && !legacyMessage.includes('access_denied')) {
      return err(transactionOffersAttempt.error);
    }
    if (hasSpecificAccessDeniedSignal || hasSpecificBlockSignal) {
      if (modernLooksMoreSpecific) return err(modernEndpointAttempt.error);
      if (transactionLooksMoreSpecific) return err(transactionOffersAttempt.error);
      return err(legacyEndpointAttempt.error);
    }
    return err(legacyEndpointAttempt.error);
  }
}
