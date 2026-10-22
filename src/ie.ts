// Kiosk end-of-shift reports into Maan's own accounting Sheet, tab
// "Income & Expense". Pure logic over a small Sheets client, so tests run it
// against an in-memory sheet.
//
// Income & Expense has one row per kiosk per day, which Maan types ahead:
//   A Date | B Month | C Category "Sales" | D "SM JAZZ KIOSK DAILY SALES - Yenna " | E Staff
//   | 3 | 6 | 12 | one column per flavor ... | WATER | Income | Expense | Account Balance
// Columns are found by their row-2 headers, so a new flavor column (added
// between "12" and "WATER") shows up on the form by itself.
//
//   readConfig   - lists for the form, and the last "Left" per flavor from the log tab.
//   submitReport - fills that day's kiosk row (or inserts one in date order),
//                  colours it yellow until Maan clears it, and logs the full
//                  report in "Kiosk form log".

export type Cell = string | number | boolean | null | undefined;

export interface SheetsLike {
  batchGet(ranges: string[], o?: { valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' }): Promise<{ range: string; values?: any[][] }[]>;
  batchUpdateValues(data: { range: string; values: any[][] }[], valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
  batchUpdate(requests: object[]): Promise<unknown[]>;
  getMetadata(fields?: string): Promise<any>;
}

export const IE = 'Income & Expense';
export const LOG = 'Kiosk form log';
const HEADER_ROW = 2;
const FIRST = 3;
const IE_LAST = 8000;
const LOG_LAST = 5000;
const MANILA_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const SHEETS_EPOCH_DAYS = 25569; // 1970-01-01 as a Sheets date serial
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YELLOW = { red: 1, green: 0.949, blue: 0.6 };

/** Kiosks on the form. `until` is the last day a kiosk shows (Manila closes Oct 23, 2026). */
export const KIOSKS = [
  { name: 'SM Jazz', prefix: 'SM JAZZ KIOSK DAILY SALES', until: '' },
  { name: 'SM Manila', prefix: 'SM MANILA KIOSK DAILY SALES', until: '2026-10-23' },
];
/** Kiosk staff (Ian's list). "Other" on the form takes any other name. */
export const STAFF = ['Yenna', 'Che', 'Shaira', 'Nash'];
const FLAVOR_NAMES: Record<string, string> = {
  OG: 'OG Mookies', AB: 'Almond Butter', CS: "Coffee S'mores", BN: 'Caramel Turon', MM: 'Cereal Milk', CC: 'Cookies & Cream',
  KK: 'Dark Cereal Milk', HN: 'Champorado', SB: 'Strawberry Basque', BM: 'Berry Mallows', UB: 'Ube', RR: 'Rocky Road', HH: "Matcha S'mores",
};
/** Box sales on the form, in this order. Water goes to the WATER column. */
export const PRODUCTS = [
  { name: 'Single', pcs: 1, walkin: 85 },
  { name: 'Box of 3', pcs: 3, walkin: 240 },
  { name: 'Box of 6', pcs: 6, walkin: 460 },
  { name: 'Box of 12', pcs: 12, walkin: 880 },
  { name: 'Water', pcs: 0, walkin: 30 },
];
const WATER = PRODUCTS.length - 1;
/** Payment fields, in the form's order. Income is written as their sum, in this order. */
export const PAY = ['cash', 'gcash', 'card', 'bank', 'grabAmt', 'onlineAmt'] as const;

const q = (tab: string) => `'${tab}'`;

// ---------------------------------------------------------------- small helpers
export const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.replace(/[₱,\s]/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v == null ? '' : String(v));
const blank = (v: Cell) => v === '' || v == null;

/** 'YYYY-MM-DD' -> Sheets date serial. */
export function isoToSerial(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS + SHEETS_EPOCH_DAYS;
}
/** Sheets date serial -> 'YYYY-MM-DD'. */
export function serialToIso(serial: number): string {
  return new Date(Math.round((serial - SHEETS_EPOCH_DAYS) * DAY_MS)).toISOString().slice(0, 10);
}
export function manilaParts(now: number) {
  const s = new Date(now + MANILA_OFFSET_MS).toISOString();
  return { date: s.slice(0, 10), hms: s.slice(11, 19).replace(/:/g, ''), stamp: `${s.slice(0, 10)} ${s.slice(11, 16)}` };
}
/** 0 -> A, 25 -> Z, 26 -> AA. */
export function colLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------------------------------------------------------------- layout
export type Layout = {
  date: number; month: number; category: number; description: number; staff: number;
  packs: number[]; flavors: { code: string; col: number }[]; water: number; income: number; expense: number; balance: number;
};

/** Finds the columns of Income & Expense from its row-2 headers. */
export function readLayout(header: Cell[]): Layout {
  const h = header.map((v) => str(v).trim().toUpperCase());
  const find = (name: string) => {
    const i = h.indexOf(name);
    if (i < 0) throw new Error(`Income & Expense has no "${name}" column in row ${HEADER_ROW}.`);
    return i;
  };
  const twelve = find('12');
  const water = find('WATER');
  const flavors = [];
  for (let c = twelve + 1; c < water; c++) if (h[c]) flavors.push({ code: h[c], col: c });
  return {
    date: find('DATE'), month: find('MONTH'), category: find('CATEGORY'), description: find('DESCRIPTION'), staff: find('STAFF'),
    packs: [find('3'), find('6'), twelve], flavors, water, income: find('INCOME'), expense: find('EXPENSE'), balance: find('ACCOUNT BALANCE'),
  };
}

// ---------------------------------------------------------------- config
export type Config = {
  kiosks: string[];
  staff: string[];
  flavors: { code: string; name: string }[];
  products: typeof PRODUCTS;
  last: Record<string, { date: string | null; counts: Record<string, number> }>;
  today: string;
};

export async function readConfig(client: SheetsLike, now: number): Promise<Config> {
  const [head, log] = await client.batchGet(
    [`${q(IE)}!A${HEADER_ROW}:AZ${HEADER_ROW}`, `${q(LOG)}!A2:V${LOG_LAST}`],
    { valueRenderOption: 'UNFORMATTED_VALUE' },
  );
  const layout = readLayout(head.values?.[0] ?? []);
  const today = manilaParts(now).date;
  const kiosks = KIOSKS.filter((k) => !k.until || k.until >= today).map((k) => k.name);
  const last: Config['last'] = {};
  for (const k of kiosks) last[k] = lastCounts(log.values ?? [], k);
  return {
    kiosks,
    staff: STAFF,
    flavors: layout.flavors.map((f) => ({ code: f.code, name: FLAVOR_NAMES[f.code] ?? f.code })),
    products: PRODUCTS,
    last,
    today,
  };
}

/** "Left" per flavor from the latest logged report of a kiosk (log column V). */
export function lastCounts(log: any[][], kiosk: string) {
  let best: any[] | undefined;
  for (const r of log) {
    if (!r || str(r[3]) !== kiosk || typeof r[2] !== 'number' || !r[21]) continue;
    if (!best || r[2] > best[2] || (r[2] === best[2] && str(r[0]) > str(best[0]))) best = r;
  }
  if (!best) return { date: null, counts: {} };
  try {
    return { date: serialToIso(best[2]), counts: JSON.parse(str(best[21])) as Record<string, number> };
  } catch {
    return { date: null, counts: {} };
  }
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
  const boxes = (Array.isArray(body.boxes) ? body.boxes : []).slice(0, PRODUCTS.length).map((v: unknown) => count(v));
  const money = (k: string) => count(body[k], 10_000_000);
  return {
    date, branch, staff1, staff2: text(body.staff2, 60), boxes, lines,
    cash: money('cash'), gcash: money('gcash'), card: money('card'), bank: money('bank'),
    grabAmt: money('grabAmt'), onlineAmt: money('onlineAmt'), discount: money('discount'),
    notes: text(body.notes, 1000),
  };
}

/** Income as Maan writes it: the amounts added up, always in the form's order (cash, GCash, card, bank, Grab/Panda, online). */
export const incomeFormula = (r: Report) => `=${PAY.map((k) => r[k]).join('+')}`;

/** Text written with USER_ENTERED must not turn into a formula. */
const plain = (s: unknown) => {
  const t = str(s);
  return /^[=+\-@']/.test(t) ? `'${t}` : t;
};

export async function submitReport(client: SheetsLike, r: Report, now: number) {
  const kiosk = KIOSKS.find((k) => k.name === r.branch);
  if (!kiosk) throw new ReportError('Pick the kiosk.');
  const [head, body] = await client.batchGet(
    [`${q(IE)}!A${HEADER_ROW}:AZ${HEADER_ROW}`, `${q(IE)}!A${FIRST}:AZ${IE_LAST}`],
    { valueRenderOption: 'UNFORMATTED_VALUE' },
  );
  const L = readLayout(head.values?.[0] ?? []);
  const rows = body.values ?? [];
  const day = isoToSerial(r.date);
  const ours = (v: Cell[] | undefined) =>
    !!v && v[L.date] === day && str(v[L.description]).trim().toUpperCase().startsWith(kiosk.prefix);
  const empty = (v: Cell[]) => blank(v[L.income]) && L.flavors.every((f) => blank(v[f.col])) && blank(v[L.water]);

  // The pre-typed row for this kiosk and day, if it is still empty.
  let idx = rows.findIndex((v) => ours(v) && empty(v));
  const duplicate = rows.some((v) => ours(v) && !empty(v));
  const requests: object[] = [];
  const meta = await client.getMetadata('sheets.properties(sheetId,title)');
  const sheetId = meta?.sheets?.find((s: any) => s.properties?.title === IE)?.properties?.sheetId;
  if (sheetId == null) throw new Error(`The "${IE}" tab was not found.`);

  let inserted = false;
  if (idx < 0) {
    // No free row: add one after the last row dated on or before the report day.
    let after = -1;
    rows.forEach((v, i) => {
      if (typeof v?.[L.date] === 'number' && v[L.date] <= day) after = i;
    });
    if (after < 0) rows.forEach((v, i) => {
      if (v?.some((c: Cell) => !blank(c))) after = i;
    });
    idx = after + 1;
    inserted = true;
    await client.batchUpdate([
      { insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: FIRST - 1 + idx, endIndex: FIRST + idx }, inheritFromBefore: idx > 0 } },
    ]);
  }
  const row = FIRST + idx;
  const width = L.balance + 1;
  const line: Cell[] = new Array(width).fill(null); // null = leave the cell as it is
  const staff = [r.staff1, r.staff2].map((s) => str(s).trim()).filter(Boolean).join(' & ');
  if (inserted) {
    line[L.date] = day;
    line[L.month] = MONTHS[Number(r.date.slice(5, 7)) - 1];
    line[L.category] = 'Sales';
    line[L.description] = plain(`${kiosk.prefix} - ${r.staff1} `);
    const inc = colLetter(L.income), exp = colLetter(L.expense);
    line[L.balance] = `=${inc}${row}-${exp}${row}`;
  }
  line[L.staff] = plain(staff);
  const sold: Record<string, number> = {};
  for (const l of r.lines) sold[l.code] = (sold[l.code] ?? 0) + l.sold;
  for (const f of L.flavors) line[f.col] = sold[f.code] ? sold[f.code] : '';
  line[L.water] = r.boxes[WATER] ? r.boxes[WATER] : '';
  line[L.income] = incomeFormula(r);

  const data = [] as { range: string; values: any[][] }[];
  // Write only the cells we set, in runs, so Maan's other cells stay untouched.
  for (let c = 0; c < width; ) {
    if (line[c] === null) {
      c++;
      continue;
    }
    let end = c;
    while (end + 1 < width && line[end + 1] !== null) end++;
    data.push({ range: `${q(IE)}!${colLetter(c)}${row}:${colLetter(end)}${row}`, values: [line.slice(c, end + 1)] });
    c = end + 1;
  }
  await client.batchUpdateValues(data, 'USER_ENTERED');
  await client.batchUpdate([
    {
      repeatCell: {
        range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: width },
        cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: YELLOW } } },
        fields: 'userEnteredFormat.backgroundColorStyle',
      },
    },
  ]);

  const { stamp, hms } = manilaParts(now);
  const id = `${r.branch.replace(/[^A-Za-z]/g, '').toUpperCase()}-${r.date.replace(/-/g, '')}-${hms}`;
  await logReport(client, r, { id, stamp, row, staff, day });
  return { id, row, duplicate, inserted };
}

async function logReport(client: SheetsLike, r: Report, x: { id: string; stamp: string; row: number; staff: string; day: number }) {
  const [log] = await client.batchGet([`${q(LOG)}!A2:A${LOG_LAST}`], { valueRenderOption: 'UNFORMATTED_VALUE' });
  const at = 2 + (log.values ?? []).length;
  const left: Record<string, number> = {};
  for (const l of r.lines) left[l.code] = l.remain;
  const detail = r.lines.map((l) => `${l.code} ${l.start}+${l.delivered}-${l.free}-${l.sold}=${l.remain}`).join(', ');
  const total = PAY.reduce((s, k) => s + r[k], 0);
  const boxes = PRODUCTS.map((_, i) => r.boxes[i] || '');
  await client.batchUpdateValues(
    [{
      range: `${q(LOG)}!A${at}:V${at}`,
      values: [[x.stamp, x.id, x.day, r.branch, x.staff, x.row, total, ...PAY.map((k) => r[k] || ''), r.discount || '', ...boxes, detail, r.notes ?? '', JSON.stringify(left)]],
    }],
    'RAW',
  );
}
