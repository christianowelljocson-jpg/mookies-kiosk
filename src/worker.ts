// Cloudflare Worker for the kiosk report.
// - GET  /            the form (public/index.html, served from static assets)
// - GET  /api/config  kiosks, staff, flavors, box prices and the last "Left" counts
// - POST /api/report  fills that day's kiosk row in Income & Expense (src/ie.ts)
import { createSheetsClient } from './sheets/client.js';
import { createTokenProvider } from './sheets/google-auth.js';
import { parseReport, readConfig, ReportError, submitReport, type SheetsLike } from './ie';

export interface Env {
  ENVIRONMENT?: string;
  /** The accounting spreadsheet (Mookies_Operations_and_Finance). Not a secret. */
  SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  /** Worker secret. */
  GOOGLE_PRIVATE_KEY?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

const log = (event: string, data: object = {}) => console.log(JSON.stringify({ event, ...data }));

let cached: { key: string; client: SheetsLike } | undefined;
export function sheetsFor(env: Env): SheetsLike {
  const missing = (['SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`Google Sheets is not configured. Missing: ${missing.join(', ')}`);
  const key = `${env.SHEET_ID}|${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`;
  if (cached?.key !== key) {
    const getToken = createTokenProvider({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL!, privateKey: env.GOOGLE_PRIVATE_KEY! });
    cached = { key, client: createSheetsClient({ spreadsheetId: env.SHEET_ID!, getToken, maxAttempts: 3 }) as unknown as SheetsLike };
  }
  return cached.client;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });

export async function handleApi(request: Request, env: Env, deps: { client?: SheetsLike; now?: () => number } = {}): Promise<Response> {
  const url = new URL(request.url);
  const now = deps.now ?? Date.now;
  let client: SheetsLike;
  try {
    client = deps.client ?? sheetsFor(env);
  } catch (e) {
    log('sheets_not_configured', { error: String(e) });
    return json({ error: 'The kiosk form is not set up yet. Tell Ian.' }, 503);
  }
  try {
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json(await readConfig(client, now()));
    }
    if (url.pathname === '/api/report' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Send the report from the kiosk page.' }, 403);
      const raw = await request.text();
      if (raw.length > 20_000) return json({ error: 'The report is too large.' }, 413);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'The report could not be read. Reload the page and try again.' }, 400);
      }
      const cfg = await readConfig(client, now());
      const report = parseReport(body, cfg);
      const saved = await submitReport(client, report, now());
      log('kiosk_report_saved', saved);
      return json({ ok: true, id: saved.id, duplicate: saved.duplicate });
    }
    return json({ error: 'Not found.' }, url.pathname.startsWith('/api/') ? 404 : 405);
  } catch (e) {
    if (e instanceof ReportError) return json({ error: e.message }, 400);
    const detail = e instanceof Error ? e.message : String(e);
    log('kiosk_api_failed', { path: url.pathname, error: detail });
    // detail never contains the key or token, only Google's error text, so it is safe to show for troubleshooting.
    return json({ error: 'Google Sheets did not answer. Wait a minute and tap Send again.', detail }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
