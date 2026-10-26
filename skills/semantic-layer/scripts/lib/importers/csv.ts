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

// Splits CSV text into records of raw field strings.
export function parseCsvRecords(text: string, options: CsvOptions = {}): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(src);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let quoteLine = 0;
  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
    } else if (ch === delimiter) endField();
    else if (ch === "\r" && src[i + 1] === "\n") {
      i++;
      line++;
      endRecord();
    } else if (ch === "\n" || ch === "\r") {
      line++;
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new UserError(`CSV: the quoted field starting on line ${quoteLine} is never closed.`);
  if (field !== "" || record.length) endRecord();
  return records;
}

// Parses CSV with a header row into row objects keyed by lowercase header names.
// Missing trailing fields read as empty strings; fields past the header are ignored.
export function parseCsv(text: string, options: CsvOptions = {}): Record<string, string>[] {
  const records = parseCsvRecords(text, options);
  const header = records[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return records.slice(1).map((r) => {
    const row: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (k && !(k in row)) row[k] = r[i] ?? "";
    });
    return row;
  });
}
