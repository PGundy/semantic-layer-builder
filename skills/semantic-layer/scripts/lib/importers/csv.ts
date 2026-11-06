// A small RFC 4180 CSV reader: quoted fields may hold the delimiter, doubled
// quotes and line breaks; records end in LF or CRLF. Rows come back as objects
// keyed by the lowercased, trimmed header.
import { UserError } from "../errors.ts";

export interface CsvOptions {
  // Field delimiter. Defaults to the first of comma, tab or semicolon found in the header line.
  delimiter?: string;
}

function detectDelimiter(text: string): string {
  let header = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    if (!quoted) header += ch;
  }
  for (const d of [",", "\t", ";", "|"]) if (header.includes(d)) return d;
  return ",";
}

// Calls `onRecord` with each record's raw field strings, in order. Fields are sliced from the
// text rather than built a character at a time, so a large export parses in one pass without
// holding every record at once.
export function forEachCsvRecord(text: string, onRecord: (record: string[]) => void, options: CsvOptions = {}): void {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(src);
  const d = delimiter.length === 1 ? delimiter.charCodeAt(0) : -1;
  const n = src.length;
  let record: string[] = [];
  let line = 1;
  const endRecord = () => {
    if (!(record.length === 1 && record[0] === "")) onRecord(record);
    record = [];
  };
  let i = 0;
  // Each iteration reads one field and the delimiter or line break after it.
  while (i < n) {
    let field = "";
    if (src.charCodeAt(i) === 34) {
      // A quoted part: "" is a quote; it may hold delimiters and line breaks.
      const quoteLine = line;
      let from = ++i;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q < 0) throw new UserError(`CSV: the quoted field starting on line ${quoteLine} is never closed.`);
        for (let k = src.indexOf("\n", i); k >= 0 && k < q; k = src.indexOf("\n", k + 1)) line++;
        if (src.charCodeAt(q + 1) === 34) {
          field += src.slice(from, q + 1);
          i = from = q + 2;
          continue;
        }
        field += src.slice(from, q);
        i = q + 1;
        break;
      }
    }
    // Unquoted text, or text after a closing quote, runs to the delimiter or line break.
    const from = i;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === d || c === 10 || c === 13) break;
      i++;
    }
    if (i > from) field += src.slice(from, i);
    record.push(field);
    if (i >= n) break;
    const c = src.charCodeAt(i);
    i++;
    if (c === d) {
      // A delimiter as the last character still ends a field: the record ends with an empty one.
      if (i >= n) record.push("");
      continue;
    }
    if (c === 13 && src.charCodeAt(i) === 10) i++;
    line++;
    endRecord();
  }
  if (record.length) endRecord();
}

// Splits CSV text into records of raw field strings.
export function parseCsvRecords(text: string, options: CsvOptions = {}): string[][] {
  const records: string[][] = [];
  forEachCsvRecord(text, (r) => records.push(r), options);
  return records;
}

// Parses CSV with a header row into row objects keyed by lowercase header names.
// Missing trailing fields read as empty strings; fields past the header are ignored.
export function parseCsv(text: string, options: CsvOptions = {}): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  forEachCsvRow(text, (row) => rows.push(row), options);
  return rows;
}

// Calls `onRow` with each row of parseCsv, without building the whole list first.
export function forEachCsvRow(text: string, onRow: (row: Record<string, string>) => void, options: CsvOptions = {}): void {
  let keys: string[] | null = null;
  // Short values repeat from row to row (schema, table and type names, YES and NO), so each is
  // kept once; the table caps the memory this takes on a file of unique values.
  const seen = new Map<string, string>();
  const intern = (v: string): string => {
    if (v.length > 64) return v;
    const hit = seen.get(v);
    if (hit !== undefined) return hit;
    if (seen.size < 200_000) seen.set(v, v);
    return v;
  };
  forEachCsvRecord(
    text,
    (r) => {
      if (!keys) {
        keys = r.map((h) => h.trim().toLowerCase());
        return;
      }
      const row: Record<string, string> = {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (k && !(k in row)) row[k] = intern(r[i] ?? "");
      }
      onRow(row);
    },
    options,
  );
}
