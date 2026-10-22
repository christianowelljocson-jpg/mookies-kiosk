// Kiosk end-of-shift reports against the Mookies accounting Sheet
// ("Mookies_Operations_and_Finance"). Pure logic over a small Sheets client,
// so tests run it against an in-memory sheet.
//
//   readConfig  - lists for the form (SETTINGS named ranges) and the last
//                 "Left" count per flavor (KIOSK STOCK).
//   submitReport - one Pending row in KIOSK REPORTS, one row per flavor in
//                 KIOSK STOCK. Written RAW, so typed text is never a formula.
//   syncLedger  - the 5-minute cron. Every report whose Status is Approved is
//                 posted to LEDGER (Source "Kiosk form", Ref ID = submission
//                 ID). A report that is no longer Approved has its rows
//                 removed. An approved report that was edited is re-posted.
//                 Column AO records what was posted ("2 row(s) posted · <fp>").
//
// The column layout matches the old Apps Script (Code.gs) exactly, so the
// Sheet's formulas, reports and DATA CHECKS keep working unchanged.

export type Cell = string | number | boolean | null | undefined;
export type Rows = Cell[][];

export interface SheetsLike {
  batchGet(ranges: string[], o?: { valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' }): Promise<{ range: string; values?: any[][] }[]>;
  batchUpdateValues(data: { range: string; values: any[][] }[], valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
}

export const KR = 'KIOSK REPORTS';
export const KS = 'KIOSK STOCK';
export const LG = 'LEDGER';
export const FIRST = 5;
const KR_LAST = 3000;
const KS_LAST = 8000;
const LG_LAST = 20000;
export const SLOTS = 20;
const PRODUCT_SLOTS = 5;
const MANILA_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const SHEETS_EPOCH_DAYS = 25569; // 1970-01-01 as a Sheets date serial
const SOURCE = 'Kiosk form';
const MAX_POSTS_PER_RUN = 25;

const q = (tab: string) => `'${tab}'`;

// ---------------------------------------------------------------- small helpers
export const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.replace(/[₱,\s]/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};
const blankZero = (v: unknown): number | '' => num(v) || '';
const str = (v: unknown) => (v == null ? '' : String(v));

/** 'YYYY-MM-DD' -> Sheets date serial. */
export function isoToSerial(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS + SHEETS_EPOCH_DAYS;
}
/** Sheets date serial -> 'YYYY-MM-DD'. */
export function serialToIso(serial: number): string {
  return new Date(Math.round((serial - SHEETS_EPOCH_DAYS) * DAY_MS)).toISOString().slice(0, 10);
}
/** The Manila wall-clock time of `now` as a Sheets date-time serial. */
export function manilaSerial(now: number): number {
  return (now + MANILA_OFFSET_MS) / DAY_MS + SHEETS_EPOCH_DAYS;
}
export function manilaParts(now: number) {
  const s = new Date(now + MANILA_OFFSET_MS).toISOString();
  return { date: s.slice(0, 10), hms: s.slice(11, 19).replace(/:/g, '') };
}
/** Text written with USER_ENTERED must not turn into a formula. */
const plain = (s: unknown) => {
  const t = str(s);
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
};

function col(values: any[][] | undefined): Cell[] {
  return (values ?? []).map((r) => (r && r.length ? r[0] : ''));
}
function firstEmpty(colVals: Cell[], from = 0): number {
  for (let i = from; i < colVals.length; i++) if (colVals[i] === '' || colVals[i] == null) return i;
  return Math.max(from, colVals.length);
}
/** First index where `count` consecutive cells are empty. */
function emptyRun(colVals: Cell[], count: number): number {
  let i = firstEmpty(colVals);
  for (;;) {
    let ok = true;
    for (let k = 0; k < count; k++) {
      const v = colVals[i + k];
      if (v !== '' && v != null) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
    i = firstEmpty(colVals, i + 1);
  }
}

// ---------------------------------------------------------------- config
export type Product = { name: string; pcs: number; walkin: number };
export type Config = {
  kiosks: string[];
  staff: string[];
  flavors: { code: string; name: string }[];
  products: Product[];
  last: Record<string, { date: string | null; counts: Record<string, number> }>;
  today: string;
};

const NAMES = ['BranchList', 'BranchType', 'BranchStatus', 'StaffName', 'StaffRole', 'StaffStatus', 'FlavorCode', 'FlavorName',
  'FlavorStatus', 'ProdName', 'ProdPcs', 'PriceWalkin'] as const;

export async function readConfig(client: SheetsLike, now: number): Promise<Config> {
  const res = await client.batchGet([...NAMES, `${q(KS)}!A${FIRST}:K${KS_LAST}`], { valueRenderOption: 'UNFORMATTED_VALUE' });
  const n: Record<string, Cell[]> = {};
  NAMES.forEach((k, i) => (n[k] = col(res[i]?.values)));
  const at = (k: string, i: number) => str(n[k][i]);

  const kiosks = n.BranchList.map(str).filter((b, i) => b && at('BranchType', i) === 'Kiosk' && at('BranchStatus', i) === 'Active');
  const staff = n.StaffName.map(str).filter((s, i) => s && at('StaffStatus', i) === 'Active' && at('StaffRole', i) !== 'Baker');
  const flavors = n.FlavorCode.map((c, i) => ({ code: str(c), name: at('FlavorName', i), status: at('FlavorStatus', i) }))
    .filter((f) => f.code && f.status === 'Active')
    .map(({ code, name }) => ({ code, name }));
  const products = n.ProdName.map((p, i) => ({ name: str(p), pcs: num(n.ProdPcs[i]), walkin: num(n.PriceWalkin[i]) }))
    .filter((p) => p.name)
    .slice(0, PRODUCT_SLOTS);

  const stock = res[NAMES.length]?.values ?? [];
  const last: Config['last'] = {};
  for (const b of kiosks) last[b] = lastCounts(stock, b);
  return { kiosks, staff, flavors, products, last, today: manilaParts(now).date };
}

/** "Left" per flavor from the latest non-rejected report of a kiosk (KIOSK STOCK, UNFORMATTED values). */
export function lastCounts(stock: any[][], branch: string) {
  let best = -1;
  for (const r of stock) {
    if (!r?.[0] || str(r[2]) !== branch || str(r[9]) === 'Rejected' || str(r[0]).startsWith('EXAMPLE')) continue;
    if (typeof r[1] === 'number' && r[1] > best) best = r[1];
  }
  const counts: Record<string, number> = {};
  if (best < 0) return { date: null, counts };
  for (const r of stock) {
    if (r?.[0] && str(r[2]) === branch && str(r[9]) !== 'Rejected' && r[1] === best) counts[str(r[3])] = num(r[7]);
  }
  return { date: serialToIso(best), counts };
}

// ---------------------------------------------------------------- submit
export type Line = { code: string; start: number; delivered: number; free: number; sold: number; remain: number };
export type Report = {
  date: string;
  branch: string;
  staff1: string;
  staff2?: string;
  boxes: number[];
  cash: number;
  gcash: number;
  card: number;
  bank: number;
  grabAmt: number;
  onlineAmt: number;
  discount: number;
  notes?: string;
  lines: Line[];
};

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const count = (v: unknown, max = 100_000) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new ReportError('A number on the form is not valid.');
  return n;
};
const text = (v: unknown, max: number) => str(v).trim().slice(0, max);

/** Checks and normalises what the phone sent. Throws ReportError with a message for staff. */
export function parseReport(body: any, cfg: Pick<Config, 'kiosks' | 'flavors'>): Report {
  if (!body || typeof body !== 'object') throw new ReportError('The report is empty.');
  const date = str(body.date);
  if (!ISO.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new ReportError('Pick the date.');
  const branch = str(body.branch);
  if (!cfg.kiosks.includes(branch)) throw new ReportError('Pick the kiosk.');
  const staff1 = text(body.staff1, 60);
  if (!staff1) throw new ReportError('Pick or type the staff on duty.');
  const codes = new Set(cfg.flavors.map((f) => f.code));
  const lines: Line[] = (Array.isArray(body.lines) ? body.lines : [])
    .filter((l: any) => l && codes.has(str(l.code)))
    .map((l: any) => ({
      code: str(l.code),
      start: count(l.start),
      delivered: count(l.delivered),
      free: count(l.free),
      sold: count(l.sold),
      remain: count(l.remain),
    }))
    .filter((l: Line) => l.start || l.delivered || l.free || l.sold || l.remain);
  const boxes = (Array.isArray(body.boxes) ? body.boxes : []).slice(0, PRODUCT_SLOTS).map((v: unknown) => count(v));
  const money = (k: string) => count(body[k], 10_000_000);
  return {
    date, branch, staff1, staff2: text(body.staff2, 60), boxes, lines,
    cash: money('cash'), gcash: money('gcash'), card: money('card'), bank: money('bank'),
    grabAmt: money('grabAmt'), onlineAmt: money('onlineAmt'), discount: money('discount'),
    notes: text(body.notes, 1000),
  };
}

export async function submitReport(client: SheetsLike, r: Report, now: number) {
  const [ids, krKeys, ksIds] = await client.batchGet(
    [`${q(KR)}!AL${FIRST}:AL${KR_LAST}`, `${q(KR)}!A${FIRST}:D${KR_LAST}`, `${q(KS)}!A${FIRST}:A${KS_LAST}`],
    { valueRenderOption: 'UNFORMATTED_VALUE' },
  );
  const { hms } = manilaParts(now);
  const id = `${r.branch.replace(/[^A-Za-z]/g, '').toUpperCase()}-${r.date.replace(/-/g, '')}-${hms}`;
  const dateSerial = isoToSerial(r.date);
  const duplicate = (krKeys.values ?? []).some((k) => k && str(k[0]) !== 'Rejected' && k[2] === dateSerial && str(k[3]) === r.branch);

  const row = FIRST + firstEmpty(col(ids.values));
  const walk: (number | '')[] = [];
  for (let i = 0; i < PRODUCT_SLOTS; i++) walk.push(blankZero(r.boxes[i]));
  const none = ['', '', '', '', ''];
  const pay = [r.cash, r.gcash, r.card, r.bank, r.grabAmt, r.onlineAmt, r.discount].map(blankZero);

  const data: { range: string; values: any[][] }[] = [
    { range: `${q(KR)}!A${row}`, values: [['Pending']] },
    { range: `${q(KR)}!C${row}:F${row}`, values: [[dateSerial, r.branch, r.staff1, r.staff2 ?? '']] },
    { range: `${q(KR)}!N${row}:AM${row}`, values: [[duplicate ? 'Another report exists for this day. Reject one of them.' : '',
      ...walk, ...none, ...none, ...pay, r.notes ?? '', id, manilaSerial(now)]] },
  ];
  if (r.lines.length) {
    const ks = FIRST + emptyRun(col(ksIds.values), r.lines.length);
    const end = ks + r.lines.length - 1;
    data.push(
      { range: `${q(KS)}!A${ks}:H${end}`, values: r.lines.map((l) => [id, dateSerial, r.branch, l.code, l.start, blankZero(l.free), l.sold, l.remain]) },
      { range: `${q(KS)}!K${ks}:K${end}`, values: r.lines.map((l) => [blankZero(l.delivered)]) },
    );
  }
  await client.batchUpdateValues(data, 'RAW');
  return { id, duplicate, row };
}

// ---------------------------------------------------------------- approval -> LEDGER
type LedgerLine = { chan: string; paid: string; amount: number; packs: (number | '')[]; flav: (number | '')[] | null; notes: string };

/** The ledger rows for one KIOSK REPORTS row (values A..AO), as Code.gs built them. */
export function ledgerLines(v: Cell[], soldByFlavor: Record<string, number>, flavorSlots: string[]): LedgerLine[] {
  const flav: (number | '')[] = new Array(SLOTS).fill('');
  for (const [code, sold] of Object.entries(soldByFlavor)) {
    const i = flavorSlots.indexOf(code);
    if (i >= 0 && i < SLOTS && sold) flav[i] = sold;
  }
  const out: Omit<LedgerLine, 'flav' | 'notes'>[] = [];
  const walk = v.slice(14, 19), grab = v.slice(19, 24), online = v.slice(24, 29);
  const packs = (p: Cell[]) => [0, 1, 2, 3, 4].map((i) => blankZero(p[i]));
  let firstWalk = true;
  for (const [paid, amt] of [['Cash', v[29]], ['GCash', v[30]], ['Card', v[31]], ['Bank transfer', v[32]]] as const) {
    if (num(amt) !== 0) {
      out.push({ chan: 'Walk-in', paid, amount: num(amt), packs: firstWalk ? packs(walk) : packs([]) });
      firstWalk = false;
    }
  }
  if (firstWalk && walk.some((x) => num(x))) out.push({ chan: 'Walk-in', paid: 'Cash', amount: 0, packs: packs(walk) });
  if (num(v[33]) !== 0 || grab.some((x) => num(x))) out.push({ chan: 'Grab/Foodpanda', paid: 'Grab/Panda payout', amount: num(v[33]), packs: packs(grab) });
  if (num(v[34]) !== 0 || online.some((x) => num(x))) out.push({ chan: 'Online order', paid: 'Online payment', amount: num(v[34]), packs: packs(online) });
  if (!out.length) out.push({ chan: 'Walk-in', paid: 'Cash', amount: 0, packs: packs([]) });
  return out.map((o, k) => ({ ...o, flav: k === 0 ? flav : null, notes: k === 0 && num(v[35]) ? `Walk-in discounts ${num(v[35])}` : '' }));
}

function ledgerRow(row: number, v: Cell[], x: LedgerLine): Cell[] {
  const staff = [v[4], v[5]].map(str).filter(Boolean).join(' & ');
  const line: Cell[] = new Array(41).fill('');
  line[0] = v[2] as number;
  line[1] = `=IF(A${row}="","",DATE(YEAR(A${row}),MONTH(A${row}),1))`;
  line[2] = plain(v[3]);
  line[3] = 'Sales - Kiosk';
  line[4] = plain(`${str(v[3]).toUpperCase()} KIOSK DAILY SALES - ${staff} (${x.chan}, ${x.paid})`);
  line[5] = x.chan;
  line[6] = x.paid;
  for (let i = 0; i < 5; i++) line[7 + i] = x.packs[i];
  if (x.flav) for (let i = 0; i < SLOTS; i++) line[13 + i] = x.flav[i];
  line[33] = `=IF(COUNT(N${row}:AG${row})=0,"",SUM(N${row}:AG${row}))`;
  line[34] = x.amount;
  line[36] = `=IF(AND(AI${row}="",AJ${row}=""),"",N(AI${row})-N(AJ${row}))`;
  line[37] = SOURCE;
  line[38] = plain(v[37]);
  line[39] = x.notes;
  return line;
}

/** Short stable hash of what a posting depends on, so an edited approved report is re-posted. */
export function fingerprint(v: Cell[], soldByFlavor: Record<string, number>): string {
  const keep = [0, 2, 3, 4, 5, ...Array.from({ length: 22 }, (_, i) => 14 + i), 37].map((i) => str(v[i]));
  const sold = Object.keys(soldByFlavor).sort().map((k) => `${k}:${soldByFlavor[k]}`);
  const s = JSON.stringify([keep, sold]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
const marker = (rows: number, fp: string) => `${rows} row(s) posted · ${fp}`;

const clearRanges = (row: number) => [
  { range: `${q(LG)}!A${row}`, values: [['']] },
  { range: `${q(LG)}!C${row}:AG${row}`, values: [new Array(31).fill('')] },
  { range: `${q(LG)}!AI${row}:AJ${row}`, values: [['', '']] },
  { range: `${q(LG)}!AL${row}:AO${row}`, values: [['', '', '', '']] },
];

export async function syncLedger(client: SheetsLike, now: number, log: (event: string, data?: object) => void = () => {}) {
  const [kr, ks, lgA, lgRef, slots] = await client.batchGet(
    [`${q(KR)}!A${FIRST}:AO${KR_LAST}`, `${q(KS)}!A${FIRST}:K${KS_LAST}`, `${q(LG)}!A${FIRST}:A${LG_LAST}`,
     `${q(LG)}!AL${FIRST}:AM${LG_LAST}`, 'FlavorCode'],
    { valueRenderOption: 'UNFORMATTED_VALUE' },
  );
  const flavorSlots = col(slots.values).map(str);
  const sold: Record<string, Record<string, number>> = {};
  for (const r of ks.values ?? []) {
    if (!r?.[0]) continue;
    const by = (sold[str(r[0])] ??= {});
    by[str(r[3])] = (by[str(r[3])] ?? 0) + num(r[6]);
  }
  const posted: Record<string, number[]> = {};
  (lgRef.values ?? []).forEach((r, i) => {
    if (r && str(r[0]) === SOURCE && r[1]) (posted[str(r[1])] ??= []).push(FIRST + i);
  });
  const ledgerA = col(lgA.values);
  const writes: { range: string; values: any[][] }[] = [];
  const result = { posted: 0, removed: 0 };
  const seen = new Set<string>();

  for (const [i, v] of (kr.values ?? []).entries()) {
    const id = str(v?.[37]);
    if (!id || seen.has(id) || id.startsWith('EXAMPLE')) continue;
    seen.add(id);
    const row = FIRST + i;
    const status = str(v[0]);
    const have = posted[id] ?? [];
    const done = str(v[40]);
    if (status === 'Approved') {
      if (typeof v[2] !== 'number') continue; // no valid date yet: leave it for Maan to fix
      const fp = fingerprint(v, sold[id] ?? {});
      const lines = ledgerLines(v, sold[id] ?? {}, flavorSlots);
      if (done === marker(lines.length, fp) && have.length === lines.length) continue;
      if (result.posted >= MAX_POSTS_PER_RUN) continue;
      for (const r of have) {
        writes.push(...clearRanges(r));
        ledgerA[r - FIRST] = '';
      }
      const at = emptyRun(ledgerA, lines.length);
      const start = FIRST + at;
      lines.forEach((_, k) => (ledgerA[at + k] = 'x'));
      writes.push({ range: `${q(LG)}!A${start}:AO${start + lines.length - 1}`, values: lines.map((x, k) => ledgerRow(start + k, v, x)) });
      writes.push({ range: `${q(KR)}!AN${row}:AO${row}`, values: [[typeof v[39] === 'number' ? v[39] : manilaSerial(now), marker(lines.length, fp)]] });
      result.posted++;
      log('kiosk_posted', { id, rows: lines.length, firstRow: start });
    } else if (have.length || done) {
      for (const r of have) {
        writes.push(...clearRanges(r));
        ledgerA[r - FIRST] = '';
      }
      writes.push({ range: `${q(KR)}!AN${row}:AO${row}`, values: [['', '']] });
      result.removed++;
      log('kiosk_unposted', { id, rows: have.length, status: status || '(blank)' });
    }
  }
  if (writes.length) await client.batchUpdateValues(writes, 'USER_ENTERED');
  return result;
}
