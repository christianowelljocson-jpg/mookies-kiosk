// An in-memory spreadsheet with just what src/kiosk.ts uses: values:batchGet
// (rows up to the last row with data, trailing blanks trimmed, like Google)
// and values:batchUpdate. Named ranges resolve to a tab range.
import type { SheetsLike } from '../src/kiosk';

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function parse(range: string) {
  const m = /^'([^']+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) throw new Error(`Bad range ${range}`);
  const [, tab, c1, r1, c2, r2] = m;
  return { tab, c1: colNum(c1), r1: Number(r1) - 1, c2: colNum(c2 ?? c1), r2: Number(r2 ?? r1) - 1 };
}

export class FakeSheet implements SheetsLike {
  tabs: Record<string, any[][]> = {};
  names: Record<string, string> = {};
  calls: { kind: 'get' | 'update'; ranges: string[]; option?: string }[] = [];

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

  async batchGet(ranges: string[]) {
    this.calls.push({ kind: 'get', ranges });
    return ranges.map((range) => {
      const r = parse(this.names[range] ?? range);
      const t = this.tabs[r.tab] ?? [];
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
    this.calls.push({ kind: 'update', ranges: data.map((d) => d.range), option });
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
}

/** The SETTINGS lists as named ranges, like the live Sheet. */
export function seedSettings(s: FakeSheet) {
  const put = (name: string, colLetter: string, vals: any[]) => {
    s.names[name] = `'SETTINGS'!${colLetter}1:${colLetter}${vals.length}`;
    s.set('SETTINGS', `${colLetter}1`, vals.map((v) => [v]));
  };
  put('BranchList', 'A', ['SM Jazz', 'SM Manila', 'Studio']);
  put('BranchType', 'B', ['Kiosk', 'Kiosk', 'Studio']);
  put('BranchStatus', 'C', ['Active', 'Closed', 'Active']);
  put('StaffName', 'D', ['Yenna', 'Che', 'Rea', 'Nickie']);
  put('StaffRole', 'E', ['Kiosk sales', 'Kiosk sales', 'Baker', 'Kiosk sales']);
  put('StaffStatus', 'F', ['Active', 'Active', 'Active', 'Inactive']);
  put('FlavorCode', 'G', ['OG', 'AB', 'CS', 'SB']);
  put('FlavorName', 'H', ['OG Mookies', 'Almond Butter', "Coffee S'mores", 'Strawberry Basque']);
  put('FlavorStatus', 'I', ['Active', 'Active', 'Active', 'Retired']);
  put('ProdName', 'J', ['Single', 'Box of 3', 'Box of 6', 'Box of 12', 'Water']);
  put('ProdPcs', 'K', [1, 3, 6, 12, 0]);
  put('PriceWalkin', 'L', [85, 240, 460, 880, 30]);
}
