// An in-memory spreadsheet with just what src/ie.ts uses: values:batchGet
// (rows up to the last row with data, trailing blanks trimmed, like Google),
// values:batchUpdate, and :batchUpdate for inserting rows and row colour.
import type { SheetsLike } from '../src/ie';

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function parse(range: string) {
  const m = /^'([^']+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) throw new Error(`Bad range ${range}`);
  const [, tab, c1, r1, c2, r2] = m;
  return { tab, c1: colNum(c1), r1: Number(r1) - 1, c2: colNum(c2 ?? c1), r2: Number(r2 ?? r1) - 1 };
}

export class FakeSheet implements SheetsLike {
  tabs: Record<string, any[][]> = {};
  ids: Record<string, number> = {};
  /** Background colour per tab and 0-based row. */
  fills: Record<string, Record<number, object>> = {};
  calls: { kind: 'get' | 'update' | 'batch'; detail: unknown }[] = [];

  cell(tab: string, a1: string) {
    const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
    return this.tabs[tab]?.[Number(m[2]) - 1]?.[colNum(m[1])];
  }
  row(tab: string, row: number) {
    return this.tabs[tab]?.[row - 1] ?? [];
  }
  set(tab: string, a1: string, values: any[][]) {
    const { r1, c1 } = parse(`'${tab}'!${a1}`);
    const t = (this.tabs[tab] ??= []);
    values.forEach((rowVals, i) => {
      const row = (t[r1 + i] ??= []);
      rowVals.forEach((v, j) => (row[c1 + j] = v));
    });
  }

  async getMetadata() {
    return { sheets: Object.entries(this.ids).map(([title, sheetId]) => ({ properties: { title, sheetId } })) };
  }

  async batchGet(ranges: string[]) {
    this.calls.push({ kind: 'get', detail: ranges });
    return ranges.map((range) => {
      const r = parse(range);
      const t = this.tabs[r.tab];
      if (!t) throw new Error(`Google Sheets error 400: Unable to parse range: ${range}`);
      const out: any[][] = [];
      for (let i = r.r1; i <= r.r2 && i < t.length; i++) {
        const row = [];
        for (let j = r.c1; j <= r.c2; j++) row.push(t[i]?.[j] ?? '');
        while (row.length && (row[row.length - 1] === '' || row[row.length - 1] == null)) row.pop();
        out.push(row);
      }
      while (out.length && !out[out.length - 1].length) out.pop();
      return { range, values: out };
    });
  }

  async batchUpdateValues(data: { range: string; values: any[][] }[], option: 'RAW' | 'USER_ENTERED' = 'RAW') {
    this.calls.push({ kind: 'update', detail: { ranges: data.map((d) => d.range), option } });
    for (const d of data) {
      const r = parse(d.range);
      const vals = d.values.map((row) => row.map((v) => (option === 'USER_ENTERED' && typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v)));
      const t = (this.tabs[r.tab] ??= []);
      vals.forEach((rowVals, i) => {
        const row = (t[r.r1 + i] ??= []);
        rowVals.forEach((v, j) => (row[r.c1 + j] = v));
      });
    }
  }

  async batchUpdate(requests: any[]) {
    this.calls.push({ kind: 'batch', detail: requests });
    const tabOf = (id: number) => Object.keys(this.ids).find((k) => this.ids[k] === id)!;
    for (const q of requests) {
      if (q.insertDimension) {
        const { sheetId, startIndex, endIndex } = q.insertDimension.range;
        const tab = tabOf(sheetId);
        const t = this.tabs[tab];
        while (t.length < startIndex) t.push([]);
        t.splice(startIndex, 0, ...Array.from({ length: endIndex - startIndex }, () => []));
      } else if (q.repeatCell) {
        const { sheetId, startRowIndex } = q.repeatCell.range;
        ((this.fills[tabOf(sheetId)] ??= {})[startRowIndex] = q.repeatCell.cell.userEnteredFormat.backgroundColorStyle.rgbColor);
      }
    }
    return [];
  }
}

export const IE_HEADER = ['DATE', 'Month', 'Category', 'Description', 'Staff', 3, 6, 12,
  'OG', 'AB', 'CS', 'BN', 'MM', 'CC', 'KK', 'HN', 'WATER', ' Income', ' Expense', 'Account Balance'];

/** Income & Expense laid out like Maan's tab (row 1 group labels, row 2 headers). */
export function seedIncomeExpense(s: FakeSheet) {
  s.ids['Income & Expense'] = 279240159;
  s.ids['Kiosk form log'] = 777000111;
  s.set('Income & Expense', 'F1', [['PACK', '', '', 'FLAVOR']]);
  s.set('Income & Expense', 'A2', [IE_HEADER]);
  s.set('Kiosk form log', 'A1', [['Submitted', 'Report ID', 'Date']]);
}
