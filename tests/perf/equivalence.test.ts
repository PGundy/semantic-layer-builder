// The large-catalog fast paths give the results of the straightforward code they replace. Each
// reference below is the earlier implementation, kept here as the oracle, and each test compares
// it with the library on seeded random inputs: pattern matching and scope tests, the CSV reader,
// the snapshot file's bytes and the snapshot diff. The DuckDB adapter, which reads a result a
// chunk at a time, is compared with a read of the whole result.
import { afterAll, describe, expect, test } from "bun:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAdapter } from "../../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { normalizeDecimal, normalizeInteger } from "../../skills/semantic-layer/scripts/lib/adapters/normalize.ts";
import { UserError } from "../../skills/semantic-layer/scripts/lib/errors.ts";
import { parseCsvRecords } from "../../skills/semantic-layer/scripts/lib/importers/csv.ts";
import { findTable, qualifiedName } from "../../skills/semantic-layer/scripts/lib/naming.ts";
import {
  checkPattern,
  filterInScope,
  type GlobToken,
  inScope,
  matchesPattern,
  matchIndex,
  parsePattern,
  scopeTest,
  unmatchedPatterns,
} from "../../skills/semantic-layer/scripts/lib/patterns.ts";
import { saveSnapshot } from "../../skills/semantic-layer/scripts/lib/project.ts";
import { diffSnapshots } from "../../skills/semantic-layer/scripts/lib/snapshot-diff.ts";
import type { Scope, Snapshot, SnapshotColumn, SnapshotTable } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { parseYaml, writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, sl, tempRoot } from "../helpers.ts";

type Named = { schema?: string | null; name: string };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- References: the implementations the fast paths replace ----

function refFold(c: string): string {
  const u = c.toUpperCase();
  return u.length !== 1 || (c.charCodeAt(0) > 127 && u.charCodeAt(0) <= 127) ? c : u;
}

function refGlobMatch(tokens: GlobToken[], s: string): boolean {
  const same = (t: { c: string; exact: boolean }, c: string) => t.c === c || (!t.exact && refFold(t.c) === refFold(c));
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;
  while (i < s.length) {
    const t = tokens[p];
    if (t && (t.k === "one" || (t.k === "lit" && same(t, s[i]!)))) {
      p++;
      i++;
    } else if (t && t.k === "star") {
      starP = p++;
      starI = i;
    } else if (starP >= 0) {
      p = starP + 1;
      i = ++starI;
    } else return false;
  }
  while (tokens[p]?.k === "star") p++;
  return p === tokens.length;
}

function refMatches(pattern: string, table: Named): boolean {
  const p = parsePattern(pattern);
  const target = p.qualified ? qualifiedName(table) : table.name;
  return p.kind === "regex" ? p.re.test(target) : refGlobMatch(p.tokens, target);
}

function refInScope(scope: Scope | undefined, table: Named): boolean {
  const include = scope?.include ?? [];
  const exclude = scope?.exclude ?? [];
  if (include.length && !include.some((p) => refMatches(p, table))) return false;
  return !exclude.some((p) => refMatches(p, table));
}

function refUnmatched(scope: Scope | undefined, tables: Named[]): string[] {
  const all = [...(scope?.include ?? []), ...(scope?.exclude ?? [])];
  return [...new Set(all)].filter((p) => !tables.some((t) => refMatches(p, t)));
}

function refCsvRecords(text: string, delimiter = ","): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

const refNormType = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

function refPairByName<T>(prev: T[], next: T[], name: (x: T) => string): Map<T, T> {
  const pairs = new Map<T, T>();
  const exact = new Map<string, T>();
  for (const p of prev) if (!exact.has(name(p))) exact.set(name(p), p);
  const taken = new Set<T>();
  for (const n of next) {
    const p = exact.get(name(n));
    if (p && !taken.has(p)) {
      pairs.set(n, p);
      taken.add(p);
    }
  }
  const group = <U extends T>(items: U[]) => {
    const out = new Map<string, U[]>();
    for (const x of items) out.set(name(x).toLowerCase(), [...(out.get(name(x).toLowerCase()) ?? []), x]);
    return out;
  };
  const restPrev = group(prev.filter((p) => !taken.has(p)));
  const restNext = group(next.filter((n) => !pairs.has(n)));
  for (const [key, ns] of restNext) {
    const ps = restPrev.get(key);
    if (ns.length === 1 && ps?.length === 1) pairs.set(ns[0]!, ps[0]!);
  }
  return pairs;
}

function refDiff(previous: Snapshot, next: Snapshot) {
  const tablePairs = refPairByName(previous.tables, next.tables, qualifiedName);
  const pairedPrev = new Set(tablePairs.values());
  const diff = { tables_added: [] as string[], tables_removed: [] as string[], columns: [] as unknown[] };
  for (const t of next.tables) {
    const old = tablePairs.get(t);
    if (!old) {
      diff.tables_added.push(qualifiedName(t));
      continue;
    }
    const colPairs = refPairByName(old.columns, t.columns, (c) => c.name);
    const pairedCols = new Set(colPairs.values());
    const change = { table: qualifiedName(t), added: [] as unknown[], removed: [] as string[], retyped: [] as unknown[] };
    for (const c of t.columns) {
      const o = colPairs.get(c);
      if (!o) change.added.push({ name: c.name, type: c.type });
      else if (refNormType(o.type) !== refNormType(c.type)) change.retyped.push({ name: c.name, from: o.type, to: c.type });
    }
    for (const c of old.columns) if (!pairedCols.has(c)) change.removed.push(c.name);
    if (change.added.length || change.removed.length || change.retyped.length) diff.columns.push(change);
  }
  for (const t of previous.tables) if (!pairedPrev.has(t)) diff.tables_removed.push(qualifiedName(t));
  return diff;
}

// ---- Random inputs ----

// Name characters, with case pairs, characters whose upper case is longer (ß) or ASCII (ı, ſ),
// the Kelvin sign, a quote, wildcard characters and a dot.
const NAME_CHARS = ["a", "A", "b", "B", "f", "F", "k", "K", "s", "S", "_", "0", "1", "é", "É", "ß", "ı", "ſ", "K", '"', "*", "?", "."];

function word(rand: () => number, max: number): string {
  const n = 1 + Math.floor(rand() * max);
  let s = "";
  for (let i = 0; i < n; i++) s += NAME_CHARS[Math.floor(rand() * NAME_CHARS.length)];
  return s;
}

function randomTables(rand: () => number, n: number): Named[] {
  const schemas = [null, "a", "Ab", "s_k", "é", "k.k"];
  return Array.from({ length: n }, () => ({ schema: schemas[Math.floor(rand() * schemas.length)] ?? null, name: word(rand, 5) }));
}

const PATTERN_PIECES = ["a", "A", "b", "k", "K", "s", "S", "_", "0", "é", "É", "ß", "ı", "ſ", "K", "*", "?", "."];

function randomPattern(rand: () => number, tables: Named[]): string {
  const r = rand();
  const t = tables[Math.floor(rand() * tables.length)]!;
  if (r < 0.15) return t.name.toUpperCase();
  if (r < 0.25) return `${qualifiedName(t)}`;
  if (r < 0.3) return `"${t.name.replaceAll('"', '""')}"`;
  if (r < 0.4) return `re:${["a.*", "(?:k|s)+_?\\d", "[a-z]{1,3}", "\\w+\\.\\w+", "ß|ss", ".*k$"][Math.floor(rand() * 6)]}`;
  if (r < 0.45) return `"${word(rand, 2).replaceAll('"', '""')}"*`;
  const n = 1 + Math.floor(rand() * 5);
  let s = "";
  for (let i = 0; i < n; i++) s += PATTERN_PIECES[Math.floor(rand() * PATTERN_PIECES.length)];
  return s;
}

function randomScope(rand: () => number, tables: Named[]): Scope {
  const usable = (p: string) => !checkPattern(p);
  const list = (max: number) => Array.from({ length: Math.floor(rand() * max) }, () => randomPattern(rand, tables)).filter(usable);
  return { include: list(6), exclude: list(4) };
}

describe("pattern matching fast paths", () => {
  test("matchesPattern, inScope, scopeTest, filterInScope, unmatchedPatterns and matchIndex agree with the reference", () => {
    const rand = rng(7);
    for (let round = 0; round < 150; round++) {
      const tables = randomTables(rand, 60);
      const scope = randomScope(rand, tables);
      for (const p of [...(scope.include ?? []), ...(scope.exclude ?? [])]) {
        for (const t of tables) expect([p, t, matchesPattern(p, t)]).toEqual([p, t, refMatches(p, t)]);
      }
      const want = tables.filter((t) => refInScope(scope, t));
      expect(tables.filter((t) => inScope(scope, t))).toEqual(want);
      expect(tables.filter(scopeTest(scope))).toEqual(want);
      expect(filterInScope(scope, tables)).toEqual(want);
      expect(unmatchedPatterns(scope, tables)).toEqual(refUnmatched(scope, tables));
      const index = matchIndex(tables);
      expect(index.filter(scope)).toEqual(want);
      expect(index.unmatched(scope)).toEqual(refUnmatched(scope, tables));
      for (const p of [...(scope.include ?? []), ...(scope.exclude ?? [])]) expect(index.count(p)).toBe(tables.filter((t) => refMatches(p, t)).length);
    }
  });

  test("inScope follows a scope list that changes after its first use", () => {
    const tables: Named[] = [
      { schema: "s", name: "fct_a" },
      { schema: "s", name: "dim_b" },
    ];
    const scope: Scope = { include: ["fct_*"] };
    expect(tables.filter((t) => inScope(scope, t)).map((t) => t.name)).toEqual(["fct_a"]);
    scope.include![0] = "dim_*";
    expect(tables.filter((t) => inScope(scope, t)).map((t) => t.name)).toEqual(["dim_b"]);
    scope.exclude = ["*_b"];
    expect(tables.filter((t) => inScope(scope, t))).toEqual([]);
  });

  test("a table renamed after it was matched is matched by its new name", () => {
    const t: Named = { schema: "s", name: "fct_a" };
    expect(matchesPattern("fct_*", t)).toBe(true);
    t.name = "dim_a";
    expect(matchesPattern("fct_*", t)).toBe(false);
    expect(matchesPattern("s.dim_a", t)).toBe(true);
  });

  test("a scope with a pattern that is not usable fails as before: on the first table that reaches it, with its message", () => {
    const tables: Named[] = [{ name: "a" }, { name: "b" }];
    const scope: Scope = { include: ["a", "re:("] };
    const message = checkPattern("re:(")!.message;
    expect(() => filterInScope(scope, tables)).toThrow(message);
    expect(() => tables.filter((t) => inScope(scope, t))).toThrow(message);
    // The first include matches every table, so the broken one is never reached.
    expect(filterInScope({ include: ["*", "re:("] }, tables)).toEqual(tables);
    expect(filterInScope(scope, [])).toEqual([]);
    // matchIndex filters such a scope the same way: an exclude no included table reaches never runs.
    const index = matchIndex(tables);
    expect(() => index.filter(scope)).toThrow(message);
    expect(index.filter({ include: ["*", "re:("] })).toEqual(tables);
    expect(index.filter({ include: ["nomatch"], exclude: ["re:("] })).toEqual([]);
  });

  test("scope --clear previews a new scope when the saved scope holds an unusable exclude no table reaches", async () => {
    const t = tempRoot();
    try {
      await initProject(t.root);
      writeYaml(join(t.root, "sources", "wh.yaml"), {
        source: "wh",
        dialect: "postgres",
        intake: { mode: "export", reason: "synthetic", schemas: ["s"] },
        scope: { include: ["nomatch"], exclude: ["re:("] },
      });
      const csv = join(t.dir, "c.csv");
      writeFileSync(csv, "table_schema,table_name,column_name,data_type\ns,orders,id,int\ns,dim_x,id,int\n");
      expect((await sl(t.root, ["import", "--source", "wh", "--file", csv])).code).toBe(0);
      const r = await sl(t.root, ["scope", "--source", "wh", "--clear", "--include", "orders"]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain("Added (1): s.orders");
    } finally {
      t.cleanup();
    }
  });

  test("quoted and qualified globs, and globs that start or end with a literal, agree with the reference", () => {
    const rand = rng(99);
    const chars = ["a", "A", "k", "K", "K", "ß", "é", "É", "_", "x", "X", "1", "\u{10400}"];
    const w = (n: number) => Array.from({ length: 1 + Math.floor(rand() * n) }, () => chars[Math.floor(rand() * chars.length)]).join("");
    for (let round = 0; round < 300; round++) {
      const tables: Named[] = Array.from({ length: 40 }, () => ({ schema: rand() < 0.2 ? null : w(2), name: w(4) }));
      const patterns: string[] = [];
      for (let i = 0; i < 8; i++) {
        const t = tables[Math.floor(rand() * tables.length)]!;
        const forms = [
          `"${t.schema ?? "a"}".${w(1)}*`,
          `${t.schema ?? "a"}."${t.name}"`,
          `*${w(1)}`,
          `"${w(1)}"*`,
          `*"${w(1)}"`,
          `${w(1)}?*${w(1)}`,
          `*.${t.name.toLowerCase()}`,
          `${(t.schema ?? "a").toUpperCase()}.*`,
          t.name.toLowerCase(),
          `?${t.name.slice(1)}`,
        ];
        const p = forms[Math.floor(rand() * forms.length)]!;
        if (!checkPattern(p)) patterns.push(p);
      }
      const index = matchIndex(tables);
      for (const p of patterns) {
        const want = tables.map((t) => refMatches(p, t));
        expect([p, tables.map((t) => matchesPattern(p, t))]).toEqual([p, want]);
        expect([p, Array.from(index.matched(p)).map(Boolean)]).toEqual([p, want]);
      }
      const scope = { include: patterns.slice(0, 4), exclude: patterns.slice(4, 6) };
      const want = tables.filter((t) => refInScope(scope, t));
      expect(tables.filter(scopeTest(scope))).toEqual(want);
      expect(index.filter(scope)).toEqual(want);
    }
  });
});

describe("CSV reader", () => {
  test("parseCsvRecords agrees with the reference on random text, errors included", () => {
    const rand = rng(11);
    const pieces = ["a", "b", ",", ",", '"', '""', "\n", "\r\n", "\r", " ", "x y", "\t", ";", "é"];
    for (let round = 0; round < 3000; round++) {
      const n = Math.floor(rand() * 30);
      let text = rand() < 0.05 ? "﻿" : "";
      for (let i = 0; i < n; i++) text += pieces[Math.floor(rand() * pieces.length)];
      let want: unknown;
      let got: unknown;
      try {
        want = refCsvRecords(text, ",");
      } catch (e) {
        want = (e as Error).message;
      }
      try {
        got = parseCsvRecords(text, { delimiter: "," });
      } catch (e) {
        got = (e as Error).message;
      }
      expect([text, got]).toEqual([text, want]);
    }
  });

  test("tab and semicolon CSVs parse as a comma CSV does", () => {
    const rand = rng(5);
    const pieces = ["a", '"', '""', "\n", "\r\n", "\r", " ", "é", "D"];
    for (let round = 0; round < 2000; round++) {
      let text = "";
      for (let i = 0; i < Math.floor(rand() * 25); i++) text += pieces[Math.floor(rand() * pieces.length)];
      const run = (d: string) => {
        try {
          return parseCsvRecords(text.replaceAll("D", d), { delimiter: d });
        } catch (e) {
          return (e as Error).message;
        }
      };
      const comma = run(",");
      const as = (d: string) => (typeof comma === "string" ? comma : comma.map((rec) => rec.map((f) => f.replaceAll(",", d))));
      expect([text, run("\t")]).toEqual([text, as("\t")]);
      expect([text, run(";")]).toEqual([text, as(";")]);
    }
  });
});

describe("snapshot file", () => {
  const made: (() => void)[] = [];
  afterAll(() => {
    for (const c of made) c();
  });

  test("saveSnapshot writes the bytes JSON.stringify of the sorted snapshot gives", () => {
    const rand = rng(13);
    const t = tempRoot();
    made.push(t.cleanup);
    const texts = ["plain", 'has "quotes"', "line\nbreak", '\n  "tables": [', "é ß \u0000", ""];
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (const n of [0, 1, 2, 7, 501, 1203]) {
      const tables: SnapshotTable[] = Array.from({ length: n }, (_, i) => ({
        schema: pick([null, "a", "B", "é"]),
        name: `${pick(["t", "T", "x"])}_${(i * 7919) % 1000}`,
        kind: "table",
        row_count: pick([null, 0, 12]),
        description: pick([null, ...texts]),
        columns: Array.from({ length: Math.floor(rand() * 4) }, (_, j) => ({ name: `c${j}`, type: pick(["int", "text"]), description: pick([null, ...texts]) })),
        ...(rand() < 0.3 ? { primary_key: [] } : {}),
      }));
      const snapshot: Snapshot = { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "live", tables };
      if (rand() < 0.5) snapshot.scope_state = { in_scope: ['"tables"'], new_in_scope: [], left_scope: [] };
      saveSnapshot(t.root, snapshot);
      const sorted = { ...snapshot, tables: [...tables].sort((a, b) => `${a.schema ?? ""}.${a.name}`.localeCompare(`${b.schema ?? ""}.${b.name}`)) };
      expect(readFileSync(join(t.root, "snapshots", "wh.json"), "utf8")).toBe(`${JSON.stringify(sorted, null, 2)}\n`);
    }
  });

  test("a snapshot that cannot be written leaves the previous file whole", () => {
    const t = tempRoot();
    made.push(t.cleanup);
    const base = { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "live" } as const;
    const good: SnapshotTable = { schema: "s", name: "a", kind: "table", columns: [] };
    saveSnapshot(t.root, { ...base, tables: [good] });
    const path = join(t.root, "snapshots", "wh.json");
    const before = readFileSync(path, "utf8");
    // A BigInt cannot be written as JSON, so serializing this table throws.
    const bad = { schema: "s", name: "b", kind: "table", columns: [], row_count: 10n } as unknown as SnapshotTable;
    expect(() => saveSnapshot(t.root, { ...base, tables: [good, bad] })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(t.root, "snapshots"))).toEqual(["wh.json"]);
  });
});

describe("snapshot diff", () => {
  test("diffSnapshots agrees with the reference, with repeated and case-varied column names", () => {
    const rand = rng(17);
    const names = ["id", "ID", "Id", "amount", "AMOUNT", "status"];
    const types = ["int", "INT", "integer", " int ", "text"];
    const cols = (): SnapshotColumn[] =>
      Array.from({ length: Math.floor(rand() * 6) }, () => ({ name: names[Math.floor(rand() * names.length)]!, type: types[Math.floor(rand() * types.length)]! }));
    for (let round = 0; round < 500; round++) {
      const prevTables: SnapshotTable[] = ["a", "b", "c"].map((name) => ({ schema: "s", name, kind: "table", columns: cols() }));
      const nextTables: SnapshotTable[] = prevTables.map((t) => {
        const r = rand();
        const columns = r < 0.4 ? t.columns.map((c) => ({ ...c })) : r < 0.6 ? t.columns.map((c) => ({ ...c, type: types[Math.floor(rand() * types.length)]! })) : cols();
        return { ...t, columns };
      });
      const base = { snapshot_version: 1, source: "wh", dialect: "duckdb", captured_at: "2026-01-15T12:00:00.000Z", method: "live" } as const;
      const prev: Snapshot = { ...base, tables: prevTables };
      const next: Snapshot = { ...base, tables: nextTables };
      expect(diffSnapshots(prev, next)).toEqual(refDiff(prev, next) as ReturnType<typeof diffSnapshots>);
    }
  });
});

describe("DuckDB adapter", () => {
  const made: (() => void)[] = [];
  afterAll(() => {
    for (const c of made) c();
  });

  test("a result of many chunks reads whole and in order, as a read of the whole result does; writes stay refused", async () => {
    const t = tempRoot();
    made.push(t.cleanup);
    await initProject(t.root);
    const source = await duckdbSource(t.root, t.dir, "wh", [
      "create table t as select range as i, cast(range as decimal(12,2)) / 4 as d, 'n' || range as s, 'k' || (range % 7) as r, case when range % 3 = 0 then null else range end as m from range(5000)",
    ]);
    const sql = "select i, d, s, r, m from t order by i";
    // The reference: the whole result read at once, each value converted as the adapter does.
    const instance = await DuckDBInstance.create(source.connection!.database as string, { access_mode: "READ_ONLY" });
    const c = await instance.connect();
    const reader = await c.runAndReadAll(sql);
    const types = reader.columnTypes().map((x) => x.toString());
    const want = reader.getRowsJson().map((row) =>
      Object.fromEntries(reader.columnNames().map((col, i) => {
        const v = row[i];
        return [col, /^U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?$/.test(types[i]!) ? normalizeInteger(v) : types[i]!.startsWith("DECIMAL") ? normalizeDecimal(v) : (v ?? null)];
      })),
    );
    c.closeSync();
    instance.closeSync();
    const a = await openAdapter(t.root, source, {});
    try {
      const got = await a.query(sql);
      expect(got.columns).toEqual(["i", "d", "s", "r", "m"]);
      expect(got.rows.length).toBe(5000);
      expect(got.rows).toEqual(want);
      expect(got.rows[4999]).toEqual({ i: 4999, d: 1249.75, s: "n4999", r: "k1", m: 4999 });
      await expect(a.query("insert into t values (1, 1, 'x', 'k', 1)")).rejects.toThrow("INSERT");
      await expect(a.query("delete from t")).rejects.toThrow();
      expect((await a.query("select count(*) as n from t")).rows).toEqual([{ n: 5000 }]);
      await expect(a.query("select * from no_such_table")).rejects.toThrow();
      expect((await a.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await a.close();
    }
  });
});

describe("table lookup and YAML parsing", () => {
  // findTable before its index: a scan for the qualified name, then a unique bare name.
  function findTableRef(tables: SnapshotTable[], ref: string): SnapshotTable | undefined {
    const lower = ref.toLowerCase();
    const exact = tables.find((t) => qualifiedName(t).toLowerCase() === lower);
    if (exact) return exact;
    if (ref.includes(".")) return undefined;
    const byName = tables.filter((t) => t.name.toLowerCase() === lower);
    return byName.length === 1 ? byName[0] : undefined;
  }

  test("findTable agrees with the scan it replaces, with repeated, case-varied and schema-less names", () => {
    const rand = rng(11);
    const names = ["orders", "Orders", "customers", "events", "a.b", "refunds"];
    const schemas = [null, "sales", "Sales", "ops"];
    const tables: SnapshotTable[] = Array.from({ length: 300 }, () => ({
      schema: schemas[Math.floor(rand() * schemas.length)]!,
      name: `${names[Math.floor(rand() * names.length)]!}${rand() < 0.5 ? "" : Math.floor(rand() * 20)}`,
      kind: "table",
      columns: [],
    }));
    const refs = [...tables.map(qualifiedName), ...tables.map((t) => t.name), "nope", "sales.nope", "ORDERS", "Sales.Orders3", "a.b"];
    for (const ref of refs) expect(findTable(tables, ref)).toBe(findTableRef(tables, ref));
    // A list that grows after its first lookup is indexed again.
    tables.push({ schema: "late", name: "added_later", kind: "table", columns: [] });
    expect(findTable(tables, "added_later")).toBe(tables.at(-1));
    expect(findTable(tables, "late.added_later")).toBe(tables.at(-1));
  });

  test("parseYaml gives each caller its own copy of a text it parsed before, and throws as parse does", () => {
    const text = "model: orders\ndimensions:\n  - name: a\n    synonyms: [x]\n";
    const one = parseYaml(text) as { dimensions: { synonyms: string[] }[] };
    one.dimensions[0]!.synonyms.push("changed");
    expect(parseYaml(text)).toEqual({ model: "orders", dimensions: [{ name: "a", synonyms: ["x"] }] });
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("just text")).toBe("just text");
    expect(() => parseYaml("a: [1")).toThrow();
    expect(() => parseYaml("a: [1")).toThrow();
  });
});
