// Qualifies a layer expr or filter for a query with joins (references/spec.md, Reference
// compiler): each column of the model's own table gets its table alias, and each join reference
// the alias of the join it reads through. It reads the text the way sqlNames does (strings,
// comments, function calls, casts and lambda parameters are not columns) and keeps everything
// else, comments included, as written. The compiler dialects are postgres and duckdb.

interface Tok {
  k: "id" | "p" | "str" | "x";
  v: string;
  q: boolean;
  s: number;
  e: number;
}

function scan(sql: string): Tok[] {
  const out: Tok[] = [];
  const push = (k: Tok["k"], s: number, e: number, v = "", q = false) => out.push({ k, v, q, s, e });
  const stringEnd = (i: number, backslash: boolean): number => {
    for (i++; i < sql.length; i++) {
      if (backslash && sql[i] === "\\") i++;
      else if (sql[i] === "'") {
        if (sql[i + 1] !== "'") break;
        i++;
      }
    }
    return i + 1;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? "";
    const s = i;
    if (/\s/.test(c)) i++;
    else if (c === "'") push("str", s, (i = stringEnd(i, false)));
    else if ((c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) push("str", s, (i = stringEnd(i + 1, true)));
    else if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      push("x", s, (i = end < 0 ? sql.length : end + 2));
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)![0];
      const end = sql.indexOf(tag, i + tag.length);
      push("str", s, (i = end < 0 ? sql.length : end + tag.length));
    } else if (c === '"') {
      let v = "";
      for (i++; i < sql.length; i++) {
        if (sql[i] === '"') {
          if (sql[i + 1] !== '"') break;
          i++;
        }
        v += sql[i];
      }
      push("id", s, ++i, v, true);
    } else if (/\d/.test(c) || (c === "." && /\d/.test(next))) {
      const num = sql.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)![0];
      push("x", s, (i += num.length), num);
    } else if (/[A-Za-z_]/.test(c)) {
      const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)![0];
      push("id", s, (i += word.length), word);
    } else if (c === "-" && next === ">" && sql[i + 2] === ">") push("p", s, (i += 3), "->>");
    else if ((c === ":" && next === ":") || (c === "-" && next === ">")) push("p", s, (i += 2), c + next);
    else if (".(),:".includes(c)) push("p", s, ++i, c);
    else push("x", s, ++i);
  }
  return out;
}

// Words that are SQL syntax, not columns, where an expr names them bare. A column with one of these
// names is qualified only when the snapshot lists the table's columns.
const KEYWORDS = new Set(
  (
    "all and any array as asc asymmetric at between both by case cast collate current_date current_time current_timestamp " +
    "current_user date day desc distinct else end escape exists false filter first following for from glob group hour ilike " +
    "in interval is isnull lambda last leading like localtime localtimestamp minute month not notnull null nulls or order over " +
    "partition preceding range rows second session_user similar some symmetric then time timestamp to trailing true " +
    "unbounded unknown when with within without year zone " +
    // interval units, as in DuckDB's interval 30 days
    "days hours microsecond microseconds millisecond milliseconds minutes months quarter quarters seconds week weeks years"
  ).split(" "),
);

// Words that continue a type name after its first word: double precision, timestamp with time zone.
const TYPE_WORDS = new Set(["precision", "varying", "with", "without", "time", "zone"]);

// Names a lambda binds: x in `x -> ...`, a and b in `(a, b) -> ...` and x in DuckDB's `lambda x: ...`.
// A lambda is a function argument, so a lone x binds only after ( or a comma, and a parameter list
// holds only names and commas. Postgres's JSON operators bind nothing: ->> always, and -> with a
// string or number after it, as in `coalesce(meta->>'k', 'none')` or `(payload -> 'a') -> 0`.
function lambdaParams(toks: Tok[]): Set<string> {
  const bound = new Set<string>();
  const isP = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;
  toks.forEach((t, i) => {
    const after = toks[i + 1];
    if (isP(t, "->") && after?.k !== "str" && !(after?.k === "x" && /^[\d.]/.test(after.v))) {
      const prev = toks[i - 1];
      if (prev?.k === "id" && (isP(toks[i - 2], "(") || isP(toks[i - 2], ","))) bound.add(prev.v.toLowerCase());
      else if (isP(prev, ")")) {
        let j = i - 2;
        while (j >= 0 && (toks[j]!.k === "id" || isP(toks[j], ","))) j--;
        if (isP(toks[j], "(") && toks[j - 1]?.k !== "id") for (let k = j + 1; k < i - 1; k++) if (toks[k]!.k === "id") bound.add(toks[k]!.v.toLowerCase());
      }
    } else if (t.k === "id" && !t.q && t.v.toLowerCase() === "lambda") {
      for (let j = i + 1; toks[j]?.k === "id"; j += 2) {
        bound.add(toks[j]!.v.toLowerCase());
        if (!(toks[j + 1]?.k === "p" && toks[j + 1]!.v === ",")) break;
      }
    }
  });
  return bound;
}

export interface ColumnRef {
  parts: string[];
  quoted: boolean[];
  start: number;
  end: number;
}

// The column references of an expr: bare columns, join references and struct reads, with their
// place in the text. columns, when given, lists the table's columns (the snapshot), and a bare name
// is a column only when it is one of them; otherwise any name that is not a SQL keyword is.
export function columnRefs(sql: string, columns?: readonly string[]): ColumnRef[] {
  const toks = scan(sql);
  const bound = lambdaParams(toks);
  const lower = columns && new Set(columns.map((c) => c.toLowerCase()));
  const isP = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;
  const word = (t: Tok | undefined, v: string) => t?.k === "id" && !t.q && t.v.toLowerCase() === v;
  const out: ColumnRef[] = [];
  // A type name follows :: or a cast's as: its first word, then any word that continues it.
  let type: "none" | "first" | "rest" = "none";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "id") {
      type = isP(t, "::") ? "first" : "none";
      continue;
    }
    const parts = [t.v];
    const quoted = [t.q];
    let j = i;
    while (isP(toks[j + 1], ".") && toks[j + 2]?.k === "id") {
      parts.push(toks[j + 2]!.v);
      quoted.push(toks[j + 2]!.q);
      j += 2;
    }
    const prev = toks[i - 1];
    const after = toks[j + 1];
    const inType: boolean = type === "first" || (type === "rest" && !t.q && parts.length === 1 && TYPE_WORDS.has(t.v.toLowerCase()));
    type = inType ? "rest" : word(t, "as") ? "first" : "none";
    i = j;
    if (inType || isP(after, "(") || isP(prev, ":")) continue;
    if (!t.q && bound.has(t.v.toLowerCase())) continue;
    if (parts.length === 1) {
      const w = t.v.toLowerCase();
      // date '2025-01-01', interval '1' day, at time zone, extract(year from x)
      if (!t.q && (after?.k === "str" || prev?.k === "str" || (w === "time" && word(prev, "at")) || (w === "zone" && word(prev, "time")))) continue;
      if (!t.q && isP(prev, "(") && word(toks[i - 2], "extract")) continue;
      const column = lower ? (t.q ? columns!.includes(t.v) : lower.has(w)) : t.q || !KEYWORDS.has(w);
      if (!column) continue;
    }
    out.push({ parts, quoted, start: t.s, end: toks[j]!.e });
  }
  return out;
}

// The text with each column reference replaced by what replace returns for it (undefined keeps it).
export function rewriteRefs(sql: string, refs: ColumnRef[], replace: (r: ColumnRef) => string | undefined): string {
  let out = "";
  let at = 0;
  for (const r of refs) {
    const text = replace(r);
    if (text === undefined) continue;
    out += sql.slice(at, r.start) + text;
    at = r.end;
  }
  return out + sql.slice(at);
}
