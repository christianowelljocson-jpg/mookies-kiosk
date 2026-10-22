import { describe, expect, it } from 'vitest';
import { FakeSheet, seedSettings } from './fake-sheet';
import { isoToSerial, ledgerLines, parseReport, readConfig, ReportError, serialToIso, submitReport, syncLedger } from '../src/kiosk';
import { handleApi } from '../src/worker';

// 2026-10-22 22:10:05 in Manila
const NOW = Date.parse('2026-10-22T14:10:05Z');

function sheet() {
  const s = new FakeSheet();
  seedSettings(s);
  // Existing ledger history: rows 5-7 used, row 8 empty, row 9 used.
  s.set('LEDGER', 'A5', [[45000], [45001], [45002], [''], [45003]]);
  s.set('LEDGER', 'AL5', [['Old import', 'X1'], ['Old import', 'X2'], ['Old import', 'X3'], ['', ''], ['Old import', 'X4']]);
  return s;
}

const body = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-22',
  branch: 'SM Jazz',
  staff1: 'Yenna',
  staff2: '',
  boxes: [2, 1, 0, 0, 1],
  cash: 1000,
  gcash: 500,
  card: 0,
  bank: 0,
  grabAmt: 300,
  onlineAmt: 0,
  discount: 0,
  notes: '=HYPERLINK("x")',
  lines: [
    { code: 'OG', start: 10, delivered: 20, free: 1, sold: 3, remain: 26 },
    { code: 'AB', start: 5, delivered: 0, free: 0, sold: 2, remain: 3 },
    { code: 'CS', start: 0, delivered: 0, free: 0, sold: 0, remain: 0 },
  ],
  ...over,
});

describe('dates', () => {
  it('round-trips ISO dates through Sheets serials', () => {
    expect(isoToSerial('1970-01-01')).toBe(25569);
    expect(serialToIso(isoToSerial('2026-10-22'))).toBe('2026-10-22');
  });
});

describe('readConfig', () => {
  it('lists active kiosks, selling staff, active flavors and the last Left counts', async () => {
    const s = sheet();
    const d = isoToSerial('2026-10-21');
    s.set('KIOSK STOCK', 'A5', [
      ['SMJAZZ-20261020-220000', d - 1, 'SM Jazz', 'OG', 9, '', 1, 8, 0, 'Approved'],
      ['SMJAZZ-20261021-220000', d, 'SM Jazz', 'OG', 8, '', 2, 6, 0, 'Pending'],
      ['SMJAZZ-20261021-220000', d, 'SM Jazz', 'AB', 4, '', 1, 3, 0, 'Pending'],
      ['SMJAZZ-20261022-090000', d + 1, 'SM Jazz', 'OG', 1, '', 1, 0, 0, 'Rejected'],
    ]);
    const c = await readConfig(s, NOW);
    expect(c.kiosks).toEqual(['SM Jazz']);
    expect(c.staff).toEqual(['Yenna', 'Che']);
    expect(c.flavors.map((f) => f.code)).toEqual(['OG', 'AB', 'CS']);
    expect(c.products[1]).toEqual({ name: 'Box of 3', pcs: 3, walkin: 240 });
    expect(c.last['SM Jazz']).toEqual({ date: '2026-10-21', counts: { OG: 6, AB: 3 } });
    expect(c.today).toBe('2026-10-22');
  });
});

describe('parseReport', () => {
  const cfg = { kiosks: ['SM Jazz'], flavors: [{ code: 'OG', name: '' }] };
  it('refuses an unknown kiosk, a missing name and bad numbers', () => {
    expect(() => parseReport(body({ branch: 'Elsewhere' }), cfg)).toThrow(ReportError);
    expect(() => parseReport(body({ staff1: ' ' }), cfg)).toThrow('staff');
    expect(() => parseReport(body({ cash: -5 }), cfg)).toThrow(ReportError);
    expect(() => parseReport(body({ date: '2026-13-40' }), cfg)).toThrow('date');
  });
  it('drops unknown flavors and empty lines', () => {
    const r = parseReport(body(), { ...cfg, flavors: [{ code: 'OG', name: '' }, { code: 'CS', name: '' }] });
    expect(r.lines.map((l) => l.code)).toEqual(['OG']);
  });
});

describe('submitReport', () => {
  it('writes a Pending report row and the flavor lines, as plain values', async () => {
    const s = sheet();
    s.set('KIOSK REPORTS', 'A5', [['Rejected', '', isoToSerial('2026-10-21'), 'SM Jazz']]);
    s.set('KIOSK REPORTS', 'AL5', [['EXAMPLE-JAZZ-20261021']]);
    const cfg = await readConfig(s, NOW);
    const r = parseReport(body(), cfg);
    const out = await submitReport(s, r, NOW);
    expect(out).toEqual({ id: 'SMJAZZ-20261022-221005', duplicate: false, row: 6 });
    const row = s.row('KIOSK REPORTS', 6);
    expect(row[0]).toBe('Pending');
    expect(row.slice(2, 6)).toEqual([isoToSerial('2026-10-22'), 'SM Jazz', 'Yenna', '']);
    expect(row.slice(14, 19)).toEqual([2, 1, '', '', 1]); // boxes go in the walk-in columns
    expect(row.slice(19, 29)).toEqual(['', '', '', '', '', '', '', '', '', '']);
    expect(row.slice(29, 36)).toEqual([1000, 500, '', '', 300, '', '']);
    expect(row[36]).toBe('=HYPERLINK("x")'); // stored as text: written RAW
    expect(s.calls.at(-1)!.option).toBe('RAW');
    expect(s.row('KIOSK STOCK', 5).slice(0, 8)).toEqual(['SMJAZZ-20261022-221005', isoToSerial('2026-10-22'), 'SM Jazz', 'OG', 10, 1, 3, 26]);
    expect(s.cell('KIOSK STOCK', 'K5')).toBe(20);
    expect(s.row('KIOSK STOCK', 7)).toEqual([]);
  });

  it('flags a second report for the same kiosk and day', async () => {
    const s = sheet();
    const cfg = await readConfig(s, NOW);
    await submitReport(s, parseReport(body(), cfg), NOW);
    const second = await submitReport(s, parseReport(body(), cfg), NOW + 60_000);
    expect(second.duplicate).toBe(true);
    expect(second.row).toBe(6);
    expect(s.cell('KIOSK REPORTS', 'N6')).toMatch(/Another report/);
    expect(s.cell('KIOSK STOCK', 'A7')).toBe('SMJAZZ-20261022-221105');
  });
});

describe('ledgerLines', () => {
  it('splits money by payment like the Apps Script did', () => {
    const v: any[] = new Array(41).fill('');
    v[14] = 2; v[15] = 1; v[29] = 1000; v[30] = 500; v[33] = 300; v[35] = 50;
    const lines = ledgerLines(v, { OG: 3, AB: 2 }, ['OG', 'AB', 'CS']);
    expect(lines.map((l) => [l.chan, l.paid, l.amount])).toEqual([
      ['Walk-in', 'Cash', 1000],
      ['Walk-in', 'GCash', 500],
      ['Grab/Foodpanda', 'Grab/Panda payout', 300],
    ]);
    expect(lines[0].packs).toEqual([2, 1, '', '', '']);
    expect(lines[1].packs).toEqual(['', '', '', '', '']);
    expect(lines[0].flav!.slice(0, 3)).toEqual([3, 2, '']);
    expect(lines[1].flav).toBeNull();
    expect(lines[0].notes).toBe('Walk-in discounts 50');
  });
});

describe('syncLedger', () => {
  async function submitted() {
    const s = sheet();
    const cfg = await readConfig(s, NOW);
    const { id } = await submitReport(s, parseReport(body(), cfg), NOW);
    return { s, id };
  }
  const ledgerRefs = (s: FakeSheet) => (s.tabs.LEDGER ?? []).map((r, i) => [i + 1, r?.[37], r?.[38]]).filter((x) => x[1] === 'Kiosk form');

  it('does nothing while a report is Pending', async () => {
    const { s } = await submitted();
    const r = await syncLedger(s, NOW);
    expect(r).toEqual({ posted: 0, removed: 0 });
    expect(s.calls.filter((c) => c.kind === 'update')).toHaveLength(1); // only the submit
  });

  it('posts an approved report once, into empty ledger rows', async () => {
    const { s, id } = await submitted();
    s.set('KIOSK REPORTS', 'A5', [['Approved']]);
    expect(await syncLedger(s, NOW)).toEqual({ posted: 1, removed: 0 });
    // 3 rows (cash, GCash, Grab): first gap of 3 is rows 10-12 (row 8 is a gap of one)
    expect(ledgerRefs(s)).toEqual([[10, 'Kiosk form', id], [11, 'Kiosk form', id], [12, 'Kiosk form', id]]);
    const first = s.row('LEDGER', 10);
    expect(first[0]).toBe(isoToSerial('2026-10-22'));
    expect(first[1]).toBe('=IF(A10="","",DATE(YEAR(A10),MONTH(A10),1))');
    expect(first[3]).toBe('Sales - Kiosk');
    expect(first[4]).toBe('SM JAZZ KIOSK DAILY SALES - Yenna (Walk-in, Cash)');
    expect(first.slice(7, 12)).toEqual([2, 1, '', '', 1]);
    expect(first.slice(13, 16)).toEqual([3, 2, '']);
    expect(first[34]).toBe(1000);
    expect(s.cell('KIOSK REPORTS', 'AO5')).toMatch(/^3 row\(s\) posted · /);
    expect(typeof s.cell('KIOSK REPORTS', 'AN5')).toBe('number');
    // Second run: nothing to do.
    const before = s.calls.length;
    expect(await syncLedger(s, NOW)).toEqual({ posted: 0, removed: 0 });
    expect(s.calls.length - before).toBe(1); // just the read
  });

  it('removes the rows when Status goes back from Approved', async () => {
    const { s } = await submitted();
    s.set('KIOSK REPORTS', 'A5', [['Approved']]);
    await syncLedger(s, NOW);
    s.set('KIOSK REPORTS', 'A5', [['Rejected']]);
    expect(await syncLedger(s, NOW)).toEqual({ posted: 0, removed: 1 });
    expect(ledgerRefs(s)).toEqual([]);
    expect(s.cell('KIOSK REPORTS', 'AO5')).toBe('');
    expect(s.cell('LEDGER', 'A10')).toBe('');
    expect(s.cell('LEDGER', 'B10')).toBe('=IF(A10="","",DATE(YEAR(A10),MONTH(A10),1))'); // formula kept
  });

  it('re-posts an approved report after Maan edits it', async () => {
    const { s, id } = await submitted();
    s.set('KIOSK REPORTS', 'A5', [['Approved']]);
    await syncLedger(s, NOW);
    s.set('KIOSK REPORTS', 'AE5', [['']]); // GCash corrected to nothing
    expect(await syncLedger(s, NOW)).toEqual({ posted: 1, removed: 0 });
    const refs = ledgerRefs(s);
    expect(refs.map((r) => r[2])).toEqual([id, id]);
    expect(s.cell('KIOSK REPORTS', 'AO5')).toMatch(/^2 row\(s\) posted/);
  });

  it('skips the example row', async () => {
    const s = sheet();
    s.set('KIOSK REPORTS', 'A5', [['Approved', '', 46000, 'SM Jazz', 'Yenna']]);
    s.set('KIOSK REPORTS', 'AL5', [['EXAMPLE-JAZZ-20261021']]);
    expect(await syncLedger(s, NOW)).toEqual({ posted: 0, removed: 0 });
  });
});

describe('API', () => {
  it('serves the config and saves a report', async () => {
    const s = sheet();
    const env = {};
    const cfg = await handleApi(new Request('https://kiosk.test/api/config'), env, { client: s, now: () => NOW });
    expect(cfg.status).toBe(200);
    expect((await cfg.json()).kiosks).toEqual(['SM Jazz']);
    const res = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', headers: { origin: 'https://kiosk.test' }, body: JSON.stringify(body()) }),
      env,
      { client: s, now: () => NOW },
    );
    expect(await res.json()).toEqual({ ok: true, id: 'SMJAZZ-20261022-221005', duplicate: false });
  });

  it('answers a bad report with a message staff can act on', async () => {
    const s = sheet();
    const res = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', body: JSON.stringify(body({ staff1: '' })) }),
      {},
      { client: s, now: () => NOW },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/staff on duty/);
  });

  it('refuses reports posted from another site', async () => {
    const res = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' }),
      {},
      { client: sheet(), now: () => NOW },
    );
    expect(res.status).toBe(403);
  });
});

describe('normalizePrivateKey', () => {
  it('accepts a bare PEM, a quoted value with \\n, or the whole JSON key file', async () => {
    const { normalizePrivateKey } = await import('../src/sheets/google-auth.js');
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
    const escaped = pem.replace(/\n/g, '\\n');
    expect(normalizePrivateKey(pem)).toBe(pem);
    expect(normalizePrivateKey(escaped)).toBe(pem);
    expect(normalizePrivateKey(`"${escaped}"`)).toBe(pem);
    expect(normalizePrivateKey(JSON.stringify({ type: 'service_account', private_key: pem }))).toBe(pem);
  });
});
