// @ts-check
// Minimal Google Sheets API v4 client for the Worker and the setup script.
// - batched reads/writes (values:batchGet, values:batchUpdate, :batchUpdate)
// - retries with exponential backoff + jitter on 429 / 5xx / network errors,
//   honouring Retry-After
// - appends (not idempotent) are retried ONLY on 429, when Google has
//   definitely not applied the write, so a row is never appended twice
// - one automatic token refresh on 401
// - a request refused by the cron's request budget (Stage 2.7) is never retried
// - a sign-in that can't succeed (bad key, Google refused it) fails at once,
//   without retries; only network / 429 / 5xx sign-in failures are retried
// All user-supplied text should be written with valueInputOption RAW so it is
// stored as plain text and never run as a formula.

import { GoogleAuthError } from './google-auth.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * True for the cron request budget's error (src/lib/server/request-budget.ts):
 * the request was never sent, and retrying can't help.
 * @param {unknown} e
 */
export const isBudgetExceeded = (e) => typeof e === 'object' && e !== null && /** @type {any} */ (e).budgetExceeded === true;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
/** Max ranges/requests sent in one batch call. */
export const BATCH_LIMIT = 100;

export class SheetsError extends Error {
  /** @param {string} message @param {{ status?: number, retryable?: boolean, deadline?: boolean }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'SheetsError';
    this.status = info.status;
    this.retryable = Boolean(info.retryable);
    /** True when the request was not sent because its `notAfter` time had passed. */
    this.deadline = Boolean(info.deadline);
  }
}

/** @template T @param {T[]} list @param {number} size @returns {T[][]} */
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * @param {{
 *   spreadsheetId: string,
 *   getToken: (() => Promise<string>) & { invalidate?: () => void },
 *   fetch?: typeof fetch,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 *   now?: () => number,
 * }} opts
 */
export function createSheetsClient({
  spreadsheetId,
  getToken,
  fetch = globalThis.fetch,
  maxAttempts = 5,
  baseDelayMs = 500,
  maxDelayMs = 16_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  now = Date.now,
}) {
  if (!spreadsheetId) throw new Error('SHEET_ID is missing.');
  const base = `${API}/${encodeURIComponent(spreadsheetId)}`;

  /** @param {number} attempt @param {Response | undefined} res */
  function delayFor(attempt, res) {
    const ra = res?.headers.get('retry-after');
    if (ra && /^\d+$/.test(ra)) return Math.min(Number(ra) * 1000, maxDelayMs);
    const exp = baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exp * (0.5 + random()), maxDelayMs);
  }

  /**
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {{ query?: Record<string, string | string[]>, body?: unknown, idempotent?: boolean, notAfter?: number }} [o]
   *   notAfter: epoch ms; the request is never sent (or re-sent after a retry
   *   wait) once this time has passed.
   */
  async function request(method, path, { query, body, idempotent = true, notAfter } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      if (notAfter !== undefined && now() > notAfter) {
        throw new SheetsError('Request not sent: its deadline has passed.', { retryable: false, deadline: true });
      }
      /** @type {Response | undefined} */
      let res;
      /** @type {string} */
      let token;
      try {
        token = await getToken();
      } catch (e) {
        // The run's request budget is used up (Stage 2.7): never retried.
        if (isBudgetExceeded(e)) throw e;
        // Sign-in that can't succeed by retrying (bad key, refused by Google): fail now.
        // (No `status` on the SheetsError: a sign-in 400 must never look like a
        // Sheets 400, which the Dates writer treats as "another writer won".)
        if (e instanceof GoogleAuthError && !e.retryable) {
          throw new SheetsError(`Google sign-in failed: ${e.message}`, { retryable: false });
        }
        // Network / 429 / 5xx during sign-in. No request was sent yet, so retrying is safe even for writes.
        if (attempt < maxAttempts) {
          await sleep(delayFor(attempt, undefined));
          continue;
        }
        throw new SheetsError(`Google sign-in failed: ${e instanceof Error ? e.message : String(e)}`, { retryable: true });
      }
      try {
        res = await fetch(url.toString(), {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // Not sent: the run's request budget is used up (Stage 2.7). Never retried.
        if (isBudgetExceeded(e)) throw e;
        // Network failure: the write may or may not have happened.
        if (idempotent && attempt < maxAttempts) {
          await sleep(delayFor(attempt, undefined));
          continue;
        }
        throw new SheetsError(`Google Sheets request failed: ${e instanceof Error ? e.message : String(e)}`, { retryable: true });
      }
      if (res.ok) return res.status === 204 ? {} : res.json();

      if (res.status === 401 && !refreshed && getToken.invalidate) {
        refreshed = true;
        getToken.invalidate();
        attempt--; // a token refresh doesn't count as an attempt
        continue;
      }
      const canRetry = idempotent ? RETRYABLE.has(res.status) : res.status === 429;
      if (canRetry && attempt < maxAttempts) {
        await sleep(delayFor(attempt, res));
        continue;
      }
      /** @type {any} */
      let detail = {};
      try {
        detail = await res.json();
      } catch {}
      throw new SheetsError(`Google Sheets error ${res.status}: ${detail?.error?.message ?? res.statusText}`, {
        status: res.status,
        retryable: RETRYABLE.has(res.status),
      });
    }
  }

  return {
    spreadsheetId,

    /** Spreadsheet metadata. @param {string} [fields] */
    getMetadata(fields) {
      return request('GET', '', { query: fields ? { fields } : {} });
    },

    /**
     * Read several ranges in one call per BATCH_LIMIT ranges.
     * @param {string[]} ranges
     * @param {{ valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' }} [o]
     * @returns {Promise<{ range: string, values?: any[][] }[]>}
     */
    async batchGet(ranges, { valueRenderOption = 'FORMATTED_VALUE' } = {}) {
      const out = [];
      for (const part of chunk(ranges, BATCH_LIMIT)) {
        /** @type {any} */
        const r = await request('GET', '/values:batchGet', { query: { ranges: part, valueRenderOption } });
        out.push(...(r.valueRanges ?? []));
      }
      return out;
    },

    /**
     * Overwrite several ranges (idempotent).
     * @param {{ range: string, values: any[][] }[]} data
     * @param {'RAW' | 'USER_ENTERED'} [valueInputOption]
     */
    async batchUpdateValues(data, valueInputOption = 'RAW') {
      for (const part of chunk(data, BATCH_LIMIT)) {
        await request('POST', '/values:batchUpdate', { body: { valueInputOption, data: part } });
      }
    },

    /**
     * Append rows after the last row of the table in `range`. Not idempotent,
     * so it is only retried on 429. Returns the range actually written.
     * @param {string} range
     * @param {any[][]} rows
     * @param {'RAW' | 'USER_ENTERED'} [valueInputOption]
     * @returns {Promise<{ updatedRange?: string }>}
     */
    async append(range, rows, valueInputOption = 'RAW') {
      /** @type {any} */
      const r = await request('POST', `/values/${encodeURIComponent(range)}:append`, {
        query: { valueInputOption, insertDataOption: 'INSERT_ROWS' },
        body: { values: rows },
        idempotent: false,
      });
      return { updatedRange: r?.updates?.updatedRange };
    },

    /**
     * Structural changes (tabs, validation, protection, formatting), sent in
     * order in chunks of BATCH_LIMIT requests. Safe to re-run the setup script
     * if a call fails part-way: it only adds what is still missing.
     * @param {object[]} requests
     * @param {{ atomic?: boolean, notAfter?: number }} [o]
     *   atomic: must be sent as ONE all-or-nothing batch; refuses to split.
     *   notAfter: epoch ms after which the batch is never sent or re-sent.
     */
    async batchUpdate(requests, { atomic = false, notAfter } = {}) {
      if (atomic && requests.length > BATCH_LIMIT) {
        throw new SheetsError(`An all-or-nothing batch can't be split (${requests.length} requests).`, { retryable: false });
      }
      const replies = [];
      for (const part of chunk(requests, BATCH_LIMIT)) {
        // Not idempotent (e.g. adding a protection twice), so only retried on 429.
        /** @type {any} */
        const r = await request('POST', ':batchUpdate', { body: { requests: part }, idempotent: false, notAfter });
        replies.push(...(r.replies ?? []));
      }
      return replies;
    },
  };
}

/** @typedef {ReturnType<typeof createSheetsClient>} SheetsClient */
