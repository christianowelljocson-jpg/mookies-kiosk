// @ts-check
// Google service-account sign-in using Web Crypto (RS256 JWT -> OAuth token).
// Works unchanged in Cloudflare Workers and in Node 20+ (setup script).
// The private key is only ever held in memory; it is never logged or echoed
// in errors.

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * A sign-in failure. `retryable` is false when trying again can't help: the
 * key can't be imported, or Google refused the sign-in (4xx other than 429).
 * Network errors while reaching Google are not wrapped and stay retryable.
 */
export class GoogleAuthError extends Error {
  /** @param {string} message @param {{ status?: number, retryable?: boolean }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = info.status;
    this.retryable = Boolean(info.retryable);
  }
}
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Private keys stored in env vars often have literal "\n" instead of newlines.
 * @param {string} pem
 */
export function normalizePrivateKey(pem) {
  return String(pem).replace(/\\n/g, '\n').trim();
}

/** @param {string} pem @returns {ArrayBuffer} */
function pemToDer(pem) {
  const text = normalizePrivateKey(pem);
  if (text.includes('BEGIN RSA PRIVATE KEY')) {
    throw new GoogleAuthError('Unsupported key format (PKCS#1). Use the service-account JSON key, which is PKCS#8 ("BEGIN PRIVATE KEY").');
  }
  if (!text.includes('BEGIN PRIVATE KEY')) {
    throw new GoogleAuthError('GOOGLE_PRIVATE_KEY is not a PEM private key ("-----BEGIN PRIVATE KEY-----" missing).');
  }
  const b64 = text.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new Error('GOOGLE_PRIVATE_KEY could not be decoded.');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** @param {Uint8Array | string} data */
export function base64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} pem @returns {Promise<CryptoKey>} */
export async function importPrivateKey(pem) {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (e) {
    if (e instanceof GoogleAuthError) throw e;
    throw new GoogleAuthError('GOOGLE_PRIVATE_KEY could not be imported as an RSA private key.');
  }
}

/**
 * Build a signed JWT assertion for Google's token endpoint.
 * @param {{ email: string, key: CryptoKey, scope: string, nowSeconds: number }} p
 */
export async function signAssertion({ email, key, scope, nowSeconds }) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: email, scope, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(sig))}`;
}

/**
 * Returns a function that yields a cached access token, refreshing a minute
 * before it expires. `invalidate()` forces a refresh (used after a 401).
 * `withFetch(f)` returns a token function that shares the same cached token
 * but makes any refresh through `f` (Stage 2.7: the cron's request budget
 * counts sign-in requests too).
 * @param {{ email: string, privateKey: string, scope?: string, fetch?: typeof fetch, now?: () => number }} opts
 */
export function createTokenProvider({ email, privateKey, scope = SHEETS_SCOPE, fetch = globalThis.fetch, now = Date.now }) {
  if (!email) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL is missing.');
  if (!privateKey) throw new Error('GOOGLE_PRIVATE_KEY is missing.');
  /** @type {Promise<CryptoKey> | undefined} */
  let keyPromise;
  /** @type {{ token: string, expiresAt: number } | undefined} */
  let cached;
  /** @type {Promise<string> | undefined} */
  let inflight;

  /** @param {typeof fetch} fetchImpl */
  async function fetchToken(fetchImpl) {
    keyPromise ??= importPrivateKey(privateKey);
    const key = await keyPromise;
    const assertion = await signAssertion({ email, key, scope, nowSeconds: Math.floor(now() / 1000) });
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    /** @type {any} */
    let body = {};
    try {
      body = await res.json();
    } catch {}
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new GoogleAuthError(`Google sign-in failed (${res.status}): ${body.error ?? 'unknown_error'}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
    cached = { token: body.access_token, expiresAt: now() + ttl * 1000 };
    return cached.token;
  }

  /** @param {typeof fetch} fetchImpl */
  const tokenVia = (fetchImpl) => {
    if (cached && cached.expiresAt - 60_000 > now()) return Promise.resolve(cached.token);
    inflight ??= fetchToken(fetchImpl).finally(() => (inflight = undefined));
    return inflight;
  };
  const invalidate = () => {
    cached = undefined;
  };
  const getToken = () => tokenVia(fetch);
  getToken.invalidate = invalidate;
  /** @param {typeof fetch} fetchImpl */
  getToken.withFetch = (fetchImpl) => {
    const g = () => tokenVia(fetchImpl);
    g.invalidate = invalidate;
    return g;
  };
  return getToken;
}
