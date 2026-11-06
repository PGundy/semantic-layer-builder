// The upgrade of an export source to a connection (spec: Setup, Upgrade from an export): the
// source file loses the export's keys, and after the catalog is read, profiled and its joins
// checked, the drafted and approved items whose data evidence contradicts them are listed for the
// owner. Nothing here edits a model or an approval.
import { type Document, isMap, type YAMLMap } from "yaml";
import { findTable, qualifiedName } from "./naming.ts";
import { KEY_TOLERANCE, LOW_CARDINALITY_MAX } from "./profile.ts";
import { approximateDistinct } from "./sql/profile.ts";
import { type Dialect, type Join, type JoinEvidence, type JoinKey, type Model, type Snapshot, type SnapshotTable, TO_ONE_RELATIONSHIPS } from "./types.ts";

export type ContradictionKind = "primary_key_not_unique" | "join_fans_out" | "unlisted_value" | "column_not_in_export";

export interface Contradiction {
  // The approve target the evidence contradicts: source.model or source.model.field.
  ref: string;
  kind: ContradictionKind;
  evidence: string;
  // Whether the item is approved: its approval stays until the owner answers.
  approved: boolean;
}

// Removes intake.reason and intake.export, which describe an export the source no longer reads.
// The export file itself stays where it is.
export function dropExportIntake(doc: Document): void {
  const intake = (doc.contents as YAMLMap).get("intake", true);
  if (!isMap(intake)) return;
  intake.delete("reason");
  intake.delete("export");
}

const MAX_VALUES = 5;
const MAX_VALUE_CHARS = 40;
const n = (x: number) => x.toLocaleString("en-US");
const lower = (s: string) => s.toLowerCase();

function column(table: SnapshotTable, name: string) {
  const bare = name.trim().replace(/^["`](.*)["`]$/, "$1");
  return table.columns.find((c) => c.name === bare) ?? table.columns.find((c) => lower(c.name) === lower(bare));
}

const keySignature = (keys: JoinKey[]) =>
  keys
    .map((k) => `${lower(String(k.from))}=${lower(String(k.to))}`)
    .sort()
    .join(",");

// Whether a join's evidence was measured for its current target and keys.
const evidenceCurrent = (j: Join, ev: JoinEvidence) =>
  (ev.to === undefined || ev.to === j.to) && !(Array.isArray(ev.keys) && Array.isArray(j.keys) && keySignature(ev.keys) !== keySignature(j.keys));

// The single-quoted literals `sql` compares the bare column `name` with: name = 'v', name <> 'v',
// name != 'v', name in ('a', 'b') and name not in (...). A column reached through a join
// (join.name) is not the model's own and is skipped.
export function listedValues(sql: string, name: string): string[] {
  const out: string[] = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`(?<![\\w.$"])"?${esc}"?(?![\\w$])\\s*(=|<>|!=|(?:not\\s+)?in\\s*\\()\\s*`, "gi");
  const literal = /^'((?:[^']|'')*)'\s*/;
  for (const m of sql.matchAll(head)) {
    let rest = sql.slice(m.index + m[0].length);
    if (!m[1]!.endsWith("(")) {
      const lit = literal.exec(rest);
      if (lit) out.push(lit[1]!.replace(/''/g, "'"));
      continue;
    }
    for (let lit = literal.exec(rest); lit; lit = literal.exec(rest)) {
      out.push(lit[1]!.replace(/''/g, "'"));
      rest = rest.slice(lit[0].length).replace(/^,\s*/, "");
    }
  }
  return out;
}

// Values a description lists in double quotes or backticks, other than `names` (lowercased): a
// description that writes a column or field name in backticks lists no value.
function quotedIn(text: unknown, names: Set<string>): string[] {
  if (typeof text !== "string") return [];
  return [...text.matchAll(/"([^"\n]{1,64})"|`([^`\n]{1,64})`/g)].map((m) => (m[1] ?? m[2])!).filter((v) => !names.has(lower(v.trim())));
}

// Words compare with case, underscores and hyphens folded, so page_view matches "page view".
const words = (s: string) => ` ${lower(s).replace(/[^a-z0-9]+/g, " ").trim()} `;

const shown = (v: string) => JSON.stringify(v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}...` : v);

// A status-like column whose owner-listed values miss a value the data holds: the model's measure
// filters (or a dimension's description, in double quotes or backticks, quoted names of the table's
// columns and the model's fields aside) list values for one of its own columns, the column has at most LOW_CARDINALITY_MAX distinct values and its profile keeps top
// values (a protected column keeps none), and a top value is neither listed nor named as a word in
// the model's description, a dimension on the column's description, or a filter's measure's
// description. Conservative: a column no filter or description lists values for is not judged.
function unlistedValues(source: string, model: Model, table: SnapshotTable): Contradiction[] {
  const out: Contradiction[] = [];
  const dims = Array.isArray(model.dimensions) ? model.dimensions : [];
  const measures = Array.isArray(model.measures) ? model.measures : [];
  const fields = [...dims, ...measures, ...(Array.isArray(model.joins) ? model.joins : [])].map((f) => f?.name);
  const names = new Set([model.model, ...fields, ...table.columns.map((c) => c.name)].filter((x) => typeof x === "string").map(lower));
  for (const col of table.columns) {
    const p = col.profile;
    const tops = (p?.top_values ?? []).filter((t) => typeof t?.value === "string" && t.value !== "");
    if (!p || p.redacted || !tops.length || typeof p.distinct_count !== "number" || p.distinct_count > LOW_CARDINALITY_MAX) continue;
    const onColumn = dims.filter((d) => typeof d?.expr === "string" && column(table, d.expr)?.name === col.name && /^["`]?[A-Za-z_][\w$]*["`]?$/.test(d.expr.trim()));
    const filtering = measures.filter((m) => typeof m?.filter === "string" && listedValues(m.filter, col.name).length);
    const listed = [...filtering.flatMap((m) => listedValues(m.filter!, col.name)), ...onColumn.flatMap((d) => quotedIn(d.description, names))];
    if (!listed.length) continue;
    const said = words([model.description, ...onColumn.map((d) => d.description), ...filtering.map((m) => m.description)].filter((x) => typeof x === "string").join(" "));
    const known = new Set(listed.map(lower));
    const missing = tops.filter((t) => !known.has(lower(String(t.value))) && !said.includes(words(String(t.value))));
    if (!missing.length) continue;
    const item = onColumn[0] ?? filtering[0]!;
    const values = missing.slice(0, MAX_VALUES).map((t) => `${shown(String(t.value))} (${n(t.count)} rows)`);
    const more = missing.length > MAX_VALUES ? `, and ${missing.length - MAX_VALUES} more` : "";
    out.push({
      ref: `${source}.${model.model}.${item.name}`,
      kind: "unlisted_value",
      evidence:
        `${col.name} holds values no filter or description names: ${values.join(", ")}${more}; ` +
        `the owner listed ${[...new Set(listed)].map(shown).join(", ")}. Ask whether they count.`,
      approved: item.status === "approved",
    });
  }
  return out;
}

// Why the data says a model's primary key is not unique, or undefined when nothing does: a
// one-column key with nulls or fewer distinct values than rows (beyond KEY_TOLERANCE when the
// profile was sampled or the dialect's distinct counts are approximate), or a join to the model on
// exactly its key columns whose current evidence found the key not unique.
function keyProblem(model: Model, table: SnapshotTable, models: Model[], dialect: Dialect): string | undefined {
  const pk = (Array.isArray(model.primary_key) ? model.primary_key : []).filter((c): c is string => typeof c === "string");
  if (!pk.length) return undefined;
  const reasons: string[] = [];
  const col = pk.length === 1 ? column(table, pk[0]!) : undefined;
  const p = col?.profile;
  const rows = table.row_count;
  if (p && typeof p.null_fraction === "number" && p.null_fraction > 0) reasons.push(`${col!.name} is null in ${Math.round(p.null_fraction * 1000) / 10}% of rows`);
  if (p && typeof p.distinct_count === "number" && typeof rows === "number" && rows > 0) {
    const loose = p.sampled === true || approximateDistinct(dialect);
    if (loose ? p.distinct_count < rows * (1 - KEY_TOLERANCE) : p.distinct_count < rows) reasons.push(`${col!.name} has ${n(p.distinct_count)} distinct values in ${n(rows)} rows`);
  }
  const wanted = [...pk.map(lower)].sort().join(",");
  for (const m of models) {
    for (const j of Array.isArray(m.joins) ? m.joins : []) {
      const ev = j?.evidence;
      if (j?.to !== model.model || !ev || ev.right_key_unique !== false || !Array.isArray(j.keys) || !evidenceCurrent(j, ev)) continue;
      if (j.keys.map((k) => lower(String(k.to))).sort().join(",") !== wanted) continue;
      reasons.push(`join ${m.model}.${j.name} found (${pk.join(", ")}) repeated in ${model.model}`);
    }
  }
  return reasons.length ? `The primary key (${pk.join(", ")}) is not unique: ${[...new Set(reasons)].join("; ")}.` : undefined;
}

// The items of `models` whose evidence contradicts them, sorted by ref and kind:
// - primary_key_not_unique (the model): see keyProblem;
// - join_fans_out (the join): a to-one join with current evidence that the target key is not
//   unique or a row matches several target rows, and no fanout_override;
// - unlisted_value (the dimension on the column, else the filtering measure): see unlistedValues;
// - column_not_in_export (the model): the live table has columns the exported table did not show,
//   other than its ignored_columns.
// `exported` is the snapshot the export gave; `live` the one introspect and profile wrote.
export function findContradictions(source: string, dialect: Dialect, exported: Snapshot | null, live: Snapshot, models: Model[]): Contradiction[] {
  const out: Contradiction[] = [];
  for (const model of models) {
    if (!model || typeof model.table !== "string" || typeof model.model !== "string") continue;
    const table = findTable(live.tables, model.table);
    if (!table) continue;
    const ref = `${source}.${model.model}`;
    const approved = model.status === "approved";
    const key = keyProblem(model, table, models, dialect);
    if (key) out.push({ ref, kind: "primary_key_not_unique", evidence: key, approved });
    for (const j of Array.isArray(model.joins) ? model.joins : []) {
      const ev = j?.evidence;
      if (!ev || !TO_ONE_RELATIONSHIPS.includes(j.relationship)) continue;
      if (typeof j.fanout_override === "string" && j.fanout_override.trim()) continue;
      if (!evidenceCurrent(j, ev)) continue;
      const why = [
        ev.right_key_unique === false ? `the key of ${j.to} is not unique` : "",
        typeof ev.max_fanout === "number" && ev.max_fanout > 1 ? `a row of ${model.model} matches up to ${n(ev.max_fanout)} rows of ${j.to}` : "",
      ].filter(Boolean);
      if (!why.length) continue;
      out.push({
        ref: `${ref}.${j.name}`,
        kind: "join_fans_out",
        evidence: `The join is ${j.relationship}, but ${why.join(", and ")}, so it repeats rows of ${model.model} and multiplies its measures.`,
        approved: j.status === "approved",
      });
    }
    out.push(...unlistedValues(source, model, table));
    const before = exported ? findTable(exported.tables, model.table) : undefined;
    if (before) {
      const ignored = new Set((Array.isArray(model.ignored_columns) ? model.ignored_columns : []).map((c) => lower(String(c))));
      const had = new Set(before.columns.map((c) => lower(c.name)));
      const unseen = table.columns.filter((c) => !had.has(lower(c.name)) && !ignored.has(lower(c.name)));
      if (unseen.length) {
        out.push({
          ref,
          kind: "column_not_in_export",
          evidence: `${qualifiedName(table)} has ${unseen.length === 1 ? "a column" : "columns"} the export did not show: ${unseen.map((c) => `${c.name} (${c.type})`).join(", ")}.`,
          approved,
        });
      }
    }
  }
  return out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

// The refs of `contradictions`, each once, in their order.
export function contradictedRefs(contradictions: Contradiction[]): string[] {
  return [...new Set(contradictions.map((c) => c.ref))];
}
