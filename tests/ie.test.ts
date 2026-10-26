import { describe, expect, it } from 'vitest';
import { FakeSheet, seedIncomeExpense, IE_HEADER } from './fake-sheet';
import { incomeFormula, isoToSerial, parseReport, readConfig, readLayout, ReportError, serialToIso, submitReport } from '../src/ie';
import { handleApi } from '../src/worker';

const IE = 'Income & Expense';
const LOG = 'Kiosk form log';
// 2026-10-22 18:30 in Manila
const NOW = Date.parse('2026-10-22T10:30:00Z');
const d = (iso: string) => isoToSerial(iso);

/** A slice of Maan's tab: rent, two pre-typed kiosk rows for Oct 22, one for Oct 23. */
function sheet() {
  const s = new FakeSheet();
  seedIncomeExpense(s);
  s.set(IE, 'A3', [
    ['', d('2026-10-21'), 'Oct', 'Sales', 'SM JAZZ KIOSK DAILY SALES - Yenna ', '', '', '', '', 2, 3, 1, 0, 4, 2, 1, 2, 3, '=500+600', '', '=S3-T3'],
    ['', d('2026-10-22'), 'Oct', 'Rental', 'SM JAZZ KIOSK RENT - NOV', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 33000, '=S4-T4'],
    ['', d('2026-10-22'), 'Oct', 'Sales', 'SM JAZZ KIOSK DAILY SALES - Yenna ', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '=S5-T5'],
    ['', d('2026-10-22'), 'Oct', 'Sales', 'SM MANILA KIOSK DAILY SALES - Che ', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '=S6-T6'],
    ['', d('2026-10-23'), 'Oct', 'Sales', 'SM JAZZ KIOSK DAILY SALES - NASH (reliever) ', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '=S7-T7'],
  ]);
  return s;
}

const body = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-22', branch: 'SM Jazz', staff1: 'Yenna', staff2: '',
  boxes: [3, 2, 1, 0, 4],
  cash: 1200, gcash: 800, card: 0, bank: 0, grabAmt: 600, onlineAmt: 0, discount: 40,
  notes: 'Busy',
  lines: [
    { code: 'OG', start: 10, delivered: 6, free: 1, sold: 8, remain: 7 },
    { code: 'HN', start: 4, delivered: 0, free: 0, sold: 3, remain: 1 },
  ],
  ...over,
});

async function submit(s: FakeSheet, over: Record<string, unknown> = {}) {
  const cfg = await readConfig(s, NOW);
  return submitReport(s, parseReport(body(over), cfg), NOW);
}

describe('layout', () => {
  it('finds the columns by header, flavors between "12" and WATER', () => {
    const L = readLayout(IE_HEADER);
    expect(L.flavors.map((f) => f.code)).toEqual(['OG', 'AB', 'CS', 'BN', 'MM', 'CC', 'KK', 'HN']);
    expect([L.approved, L.staff, L.water, L.income, L.expense, L.balance]).toEqual([0, 5, 17, 18, 19, 20]);
  });
  it('picks up a new flavor column added before WATER', () => {
    const h = [...IE_HEADER];
    h.splice(17, 0, 'SB');
    expect(readLayout(h).flavors.at(-1)).toEqual({ code: 'SB', col: 17 });
  });
  it('says which header is missing', () => {
    expect(() => readLayout(IE_HEADER.filter((x) => x !== 'Staff'))).toThrow(/"STAFF"/);
  });
});

describe('readConfig', () => {
  it('lists kiosks, staff and flavor names; Manila drops off after Oct 23', async () => {
    const s = sheet();
    const cfg = await readConfig(s, NOW);
    expect(cfg.kiosks).toEqual(['SM Jazz', 'SM Manila']);
    expect(cfg.staff).toEqual(['Yenna', 'Che', 'Shaira', 'Nash']);
    expect(cfg.flavors.at(-1)).toEqual({ code: 'HN', name: 'Champorado' });
    expect(cfg.today).toBe('2026-10-22');
    expect((await readConfig(s, Date.parse('2026-10-24T03:00:00Z'))).kiosks).toEqual(['SM Jazz']);
  });
  it('prefills Start from the last logged Left for that kiosk', async () => {
    const s = sheet();
    await submit(s);
    const cfg = await readConfig(s, NOW);
    expect(cfg.last['SM Jazz']).toEqual({ date: '2026-10-22', counts: { OG: 7, HN: 1 } });
    expect(cfg.last['SM Manila']).toEqual({ date: null, counts: {} });
  });
  it('uses a Left count Maan corrected in the log', async () => {
    const s = sheet();
    await submit(s);
    s.set(LOG, 'T2', [['10+6-1-8=6']]);
    expect((await readConfig(s, NOW)).last['SM Jazz'].counts).toEqual({ OG: 6, HN: 1 });
  });
});

describe('submitReport', () => {
  it("fills Maan's pre-typed row and leaves her other cells alone", async () => {
    const s = sheet();
    const res = await submit(s);
    expect(res).toMatchObject({ row: 5, duplicate: false, inserted: false });
    const r = s.row(IE, 5);
    expect(r.slice(0, 6)).toEqual([false, d('2026-10-22'), 'Oct', 'Sales', 'SM JAZZ KIOSK DAILY SALES - Yenna ', 'Yenna']);
    expect(r[9]).toBe(8); // OG
    expect(r[16]).toBe(3); // HN
    expect(r[10]).toBe(''); // AB not sold
    expect(r[17]).toBe(4); // water
    expect(r[18]).toBe(incomeFormula('SMJAZZ-20261022-183000')); // Income looks the report up in the log
    expect(r[19]).toBe(''); // Expense untouched
    expect(r[20]).toBe('=S5-T5'); // Balance untouched
    expect(s.checkboxes[IE]).toEqual(['4:0']); // unticked Approved box: yellow until Maan ticks it
    expect(s.row(IE, 6)[18]).toBe(''); // the Manila row is not touched
    expect(s.row(IE, 6)[0]).toBe('');
  });

  it('logs the whole report in Kiosk form log', async () => {
    const s = sheet();
    const { id } = await submit(s);
    expect(id).toBe('SMJAZZ-20261022-183000');
    const log = s.row(LOG, 2);
    expect(log.slice(0, 7)).toEqual(['2026-10-22 18:30', id, d('2026-10-22'), 'SM Jazz', 'Yenna', 5, '=SUM(H2:M2)']);
    expect(log.slice(7, 13)).toEqual([1200, 800, '', '', 600, '']);
    expect(log[13]).toBe(40); // discount
    expect(log.slice(14, 19)).toEqual([3, 2, 1, '', 4]);
    expect(log[19]).toBe('10+6-1-8=7'); // OG
    expect(log.slice(20, 26)).toEqual(['', '', '', '', '', '', ]);
    expect(log[26]).toBe('4+0-0-3=1'); // HN
    expect(log[27]).toBe('Busy');
    expect(JSON.parse(log[28])).toEqual({ OG: 7, HN: 1 });
  });

  it('gives a new flavor its own log column before Notes, and still prefills from Left', async () => {
    const s = sheet();
    const h = [...IE_HEADER];
    h.splice(17, 0, 'SB');
    s.set(IE, 'A2', [h]);
    for (const r of [3, 4, 5, 6, 7]) s.row(IE, r).splice(17, 0, '');
    await submit(s, { lines: [{ code: 'SB', start: 0, delivered: 12, free: 0, sold: 5, remain: 7 }] });
    expect(s.row(LOG, 1).slice(26, 30)).toEqual(['HN', 'SB', 'Notes', 'Left (for the form)']);
    expect(s.row(LOG, 2)[27]).toBe('0+12-0-5=7');
    expect(s.row(LOG, 2)[28]).toBe('Busy');
    expect((await readConfig(s, NOW)).last['SM Jazz'].counts).toEqual({ SB: 7 });
  });

  it('writes both staff in Staff', async () => {
    const s = sheet();
    await submit(s, { staff2: 'Che' });
    expect(s.cell(IE, 'F5')).toBe('Yenna & Che');
  });

  it('writes the staff name once when both picks are the same person', async () => {
    const s = sheet();
    await submit(s, { staff2: 'yenna' });
    expect(s.cell(IE, 'F5')).toBe('Yenna');
    expect(s.row(LOG, 2)[4]).toBe('Yenna');
  });

  it('a later report for the same kiosk and day replaces the earlier one', async () => {
    const s = sheet();
    await submit(s);
    s.set(IE, 'A5', [[true]]); // Maan had already approved it
    const res = await submit(s, { cash: 100, gcash: 0, grabAmt: 0, staff1: 'Nash', lines: [{ code: 'OG', start: 10, delivered: 0, free: 0, sold: 1, remain: 9 }] });
    expect(res).toMatchObject({ row: 5, duplicate: true, inserted: false });
    const r = s.row(IE, 5);
    expect(r[0]).toBe(false); // back to unapproved for Maan to check again
    expect(r[5]).toBe('Nash');
    expect(r[9]).toBe(1); // OG
    expect(r[16]).toBe(''); // HN cleared
    expect(r[18]).toBe(incomeFormula(res.id));
    expect(s.row(IE, 6)[4]).toBe('SM MANILA KIOSK DAILY SALES - Che '); // no extra row
    expect(s.row(LOG, 2)[4]).toBe('Nash'); // log row replaced in place
    expect(s.row(LOG, 2)[19]).toBe('10+0-0-1=9');
    expect(s.row(LOG, 2)[26]).toBe('');
    expect(s.row(LOG, 3)).toEqual([]);
    expect((await readConfig(s, NOW)).last['SM Jazz'].counts).toEqual({ OG: 9 });
  });

  it('keeps the log in shift-date order, not the order reports were sent', async () => {
    const s = sheet();
    await submit(s, { date: '2026-10-23' });
    await submit(s, { date: '2026-10-21' });
    await submit(s, { date: '2026-10-22' });
    expect([2, 3, 4].map((r) => s.row(LOG, r)[2])).toEqual([d('2026-10-21'), d('2026-10-22'), d('2026-10-23')]);
    await submit(s, { date: '2026-10-21', staff1: 'Che' }); // a resubmit stays on its date
    expect([2, 3, 4].map((r) => s.row(LOG, r)[2])).toEqual([d('2026-10-21'), d('2026-10-22'), d('2026-10-23')]);
    expect(s.row(LOG, 2)[4]).toBe('Che');
  });

  it('removes extra log rows for the same kiosk and day', async () => {
    const s = sheet();
    await submit(s);
    await submit(s, { date: '2026-10-23' });
    s.set(LOG, 'A4', [s.row(LOG, 2).slice()]); // an old duplicate of Oct 22
    await submit(s, { staff1: 'Che' });
    expect(s.row(LOG, 2)[4]).toBe('Che');
    expect(s.row(LOG, 3)[2]).toBe(d('2026-10-23'));
    expect(s.row(LOG, 4)).toEqual([]);
  });

  it('adds a new row when the day only has a row Maan typed in by hand', async () => {
    const s = sheet();
    s.set(IE, 'J5', [[5]]); // filled by hand, no Approved checkbox
    const res = await submit(s);
    expect(res).toMatchObject({ row: 7, inserted: true });
    expect(s.row(IE, 5)[9]).toBe(5);
  });

  it('adds a row in date order when no row was typed for that day', async () => {
    const s = sheet();
    const res = await submit(s, { date: '2026-11-02' });
    expect(res).toMatchObject({ row: 8, inserted: true });
    expect(s.row(IE, 8).slice(0, 5)).toEqual([false, d('2026-11-02'), 'Nov', 'Sales', 'SM JAZZ KIOSK DAILY SALES - Yenna ']);
  });

  it('never turns typed text into a formula', async () => {
    const s = sheet();
    await submit(s, { staff1: '=HYPERLINK("x")' });
    expect(s.cell(IE, 'F5')).toBe('=HYPERLINK("x")');
    const upd = s.calls.find((c) => c.kind === 'update') as any;
    expect(upd.detail.option).toBe('USER_ENTERED');
  });
});

describe('parseReport', () => {
  it('rejects an unknown kiosk, a bad date and negative numbers', async () => {
    const cfg = await readConfig(sheet(), NOW);
    expect(() => parseReport(body({ branch: 'BGC' }), cfg)).toThrow(ReportError);
    expect(() => parseReport(body({ date: '22/10/2026' }), cfg)).toThrow('Pick the date.');
    expect(() => parseReport(body({ cash: -5 }), cfg)).toThrow(ReportError);
  });
  it('drops unknown flavors and empty lines', async () => {
    const cfg = await readConfig(sheet(), NOW);
    const r = parseReport(body({ lines: [{ code: 'ZZ', sold: 3 }, { code: 'AB' }, { code: 'OG', sold: 2 }] }), cfg);
    expect(r.lines.map((l) => l.code)).toEqual(['OG']);
    expect(incomeFormula('SMJAZZ-20261022-183000')).toBe(`=SUM(IFERROR(FILTER('Kiosk form log'!H2:M,'Kiosk form log'!B2:B="SMJAZZ-20261022-183000"),0))`);
  });
});

describe('dates', () => {
  it('round-trips Sheets serials', () => {
    expect(serialToIso(isoToSerial('2026-10-22'))).toBe('2026-10-22');
  });
});

describe('handleApi', () => {
  const env = {};
  const now = () => NOW;
  it('serves the config and saves a report', async () => {
    const s = sheet();
    const c = await handleApi(new Request('https://kiosk.test/api/config'), env, { client: s, now });
    expect(c.status).toBe(200);
    const p = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', headers: { origin: 'https://kiosk.test' }, body: JSON.stringify(body()) }),
      env, { client: s, now },
    );
    expect(await p.json()).toMatchObject({ ok: true, duplicate: false });
  });
  it('refuses a report sent from another site', async () => {
    const p = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' }),
      env, { client: sheet(), now },
    );
    expect(p.status).toBe(403);
  });
  it('shows a staff message for a bad report', async () => {
    const p = await handleApi(
      new Request('https://kiosk.test/api/report', { method: 'POST', body: JSON.stringify(body({ branch: 'BGC' })) }),
      env, { client: sheet(), now },
    );
    expect(p.status).toBe(400);
    expect((await p.json()).error).toBe('Pick the kiosk.');
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
