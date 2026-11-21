// Turns the semantic models and metrics read from a dbt manifest (lib/importers/dbt-semantic.ts) into
// typed edits that `semlayer apply` runs: add-field, add-join and add-metric, each a draft. Pure: it
// reads the layer and snapshot it is given and writes nothing. Everything in a manifest is untrusted
// text, so a name becomes a field, join or metric name only if it passes the name rule the typed
// commands enforce, an expr goes through the same text check add-field's role gets, and a description
// is one plain line with credentials redacted. An item that fails any check is skipped with a reason
// and is never emitted for apply to refuse. Nothing here approves, confirms or answers for the owner.
import { parseFormula } from "./compiler/metrics.ts";
import { redactCredentials } from "./credentials.ts";
import { ignoredReads, oneLine } from "./edit.ts";
import type { DbtOutside, DbtRelation, DbtSemantic, DbtSemanticModel } from "./importers/dbt-semantic.ts";
import { findTable, qualifiedName } from "./naming.ts";
import { tablesFlag } from "./snapshot-diff.ts";
import { addPairCommand, crossSchemaLevel, crossSchemaPairs, pairOriented, schemaJoin, undeclaredJoinText } from "./schema-scope.ts";
import { readsText, sqlTextProblem, type TextRole } from "./sql-text.ts";
import { translateDbtFilter } from "./importers/dbt-filters.ts";
import { type Model, NAME_PATTERN, type Snapshot, type SnapshotTable, type SourceConfig } from "./types.ts";

export interface DbtEditsInput {
  source: SourceConfig;
  snapshot: Pick<Snapshot, "tables">;
  // The source's models in the layer, and the names already in metrics.yaml.
  models: readonly Model[];
  metricNames: readonly string[];
  // What `placeDbtSemantic` reported as not in the snapshot; those are reported there, not again here.
  outside: readonly DbtOutside[];
}

export interface DbtEditItem {
  kind: "dimension" | "measure" | "join" | "metric";
  name: string;
  ref: string;
}

export interface DbtEditSkip {
  kind: "dimension" | "measure" | "join" | "metric";
  name: string;
  reason: string;
  // The name is already in the layer: the existing item stays as it is.
  existing: boolean;
}

export interface DbtUndrafted {
  model: string;
  table: string;
  command: string;
}

export interface DbtEdits {
  edits: string[][];
  items: DbtEditItem[];
  skipped: DbtEditSkip[];
  undrafted: DbtUndrafted[];
}

const FROM_DBT = "from the dbt manifest";
const MAX_DESCRIPTION = 240;

// Manifest text as one short plain line, safe to print.
const clean = (t: string): string => oneLine(t).replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80);

// A description: one plain line, credentials redacted, cut short, and marked as imported.
function describe(text: string | null): string {
  const plain = text ? redactCredentials(oneLine(text)).text : "";
  const cut = plain.length > MAX_DESCRIPTION ? `${plain.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : plain;
  return cut ? `${cut} (${FROM_DBT})` : `Imported ${FROM_DBT}.`;
}

const BARE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/;

function tableOf(snapshot: Pick<Snapshot, "tables">, r: DbtRelation): SnapshotTable | undefined {
  const bare = findTable(snapshot.tables, r.table);
  if (!r.schema) return bare;
  return findTable(snapshot.tables, `${r.schema}.${r.table}`) ?? (r.database ? findTable(snapshot.tables, `${r.database}.${r.schema}.${r.table}`) : undefined);
}

export function toEdits(semantic: DbtSemantic, input: DbtEditsInput): DbtEdits {
  const { source, snapshot } = input;
  const src = source.source;
  const result: DbtEdits = { edits: [], items: [], skipped: [], undrafted: [] };
  const skip = (kind: DbtEditSkip["kind"], name: string, reason: string, existing = false) =>
    void result.skipped.push({ kind, name: clean(name), reason, existing });
  const hidden = (kind: DbtOutside["kind"], name: string) => input.outside.some((o) => o.kind === kind && o.name === name);

  interface Placed {
    sm: DbtSemanticModel;
    model: Model;
    table: SnapshotTable;
    // Names taken in the model: its own fields and joins plus what this run adds.
    used: Set<string>;
    // The SQL of each dbt dimension that will exist in the layer, by dbt name.
    dims: Map<string, string>;
    measures: Set<string>;
  }
  const placed = new Map<string, Placed>();
  const usedByModel = new Map<string, Set<string>>();
  for (const sm of semantic.models) {
    if (hidden("semantic_model", sm.name)) continue;
    const table = tableOf(snapshot, sm.relation);
    const model = table && input.models.find((m) => findTable(snapshot.tables, String(m.table)) === table);
    if (!table || !model) {
      const shown = table ? qualifiedName(table) : [sm.relation.schema, sm.relation.table].filter(Boolean).join(".");
      result.undrafted.push({ model: clean(sm.name), table: clean(shown), command: `semlayer draft --source ${src}${tablesFlag([clean(shown)])}` });
      continue;
    }
    // Shared by every semantic model placed on the same layer model, so a second one cannot repeat a name.
    let used = usedByModel.get(model.model);
    if (!used) {
      used = new Set([...(model.dimensions ?? []), ...(model.measures ?? []), ...(model.joins ?? [])].map((x) => x.name));
      usedByModel.set(model.model, used);
    }
    placed.set(sm.name, { sm, model, table, used, dims: new Map(), measures: new Set() });
  }

  const problem = (p: Placed, text: string | null | undefined, role: TextRole): string | undefined => {
    if (!text || !text.trim()) return "it has no expression";
    if (CONTROL.test(text)) return "its expression holds a control character";
    const bad = readsText(source.dialect) ? sqlTextProblem(text, role) : undefined;
    if (bad) return `its expression ${bad}`;
    if (BARE.test(text.trim()) && !p.table.columns.some((c) => c.name.toLowerCase() === text.trim().toLowerCase())) {
      return `${clean(text)} is not a column of ${p.model.table} in the snapshot`;
    }
    const ignored = ignoredReads(p.model, input.models, [text]);
    if (ignored.length) return `it reads ${ignored.map((r) => r.column).join(", ")}, in ignored_columns (left out on purpose)`;
    return undefined;
  };
  const free = (kind: DbtEditSkip["kind"], p: Placed, name: string): boolean => {
    if (!NAME_PATTERN.test(name)) {
      skip(kind, `${p.sm.name}.${name}`, `"${clean(name)}" is not a layer name (lowercase letters, digits and underscores, starting with a letter); add it by hand under a name that is, with semlayer add-${kind === "join" ? "join" : "field"}.`);
      return false;
    }
    if (p.used.has(name)) {
      skip(kind, `${p.model.model}.${name}`, "the model already has an item of that name; it stays as it is.", true);
      return false;
    }
    return true;
  };
  const push = (kind: DbtEditItem["kind"], ref: string, name: string, words: string[]) => {
    result.edits.push(words);
    result.items.push({ kind, name, ref });
  };

  // Dimensions and measures.
  for (const p of placed.values()) {
    const existing = new Map((p.model.dimensions ?? []).map((d) => [d.name, d.expr]));
    for (const d of p.sm.dimensions) {
      if (existing.has(d.name)) p.dims.set(d.name, existing.get(d.name)!);
      if (!free("dimension", p, d.name)) continue;
      const why = problem(p, d.expr, "dimension expr");
      if (why) {
        skip("dimension", `${p.model.model}.${d.name}`, `${why}; add it by hand with semlayer add-field ${src}.${p.model.model} --kind dimension.`);
        continue;
      }
      p.used.add(d.name);
      p.dims.set(d.name, d.expr);
      push("dimension", `${src}.${p.model.model}.${d.name}`, d.name, [
        "add-field", `${src}.${p.model.model}`, "--kind=dimension", `--name=${d.name}`, `--expr=${d.expr}`,
        `--type=${d.type === "time" ? "time" : "string"}`, `--description=${describe(d.description)}`,
      ]);
    }
    for (const m of p.sm.measures) {
      if (!free("measure", p, m.name)) continue;
      const why = m.agg === "count" && !m.expr?.trim() ? undefined : problem(p, m.expr, "measure expr");
      if (why) {
        skip("measure", `${p.model.model}.${m.name}`, `${why}; add it by hand with semlayer add-field ${src}.${p.model.model} --kind measure.`);
        continue;
      }
      p.used.add(m.name);
      p.measures.add(m.name);
      push("measure", `${src}.${p.model.model}.${m.name}`, m.name, [
        "add-field", `${src}.${p.model.model}`, "--kind=measure", `--name=${m.name}`, `--agg=${m.agg}`,
        ...(m.expr?.trim() ? [`--expr=${m.expr}`] : []), `--description=${describe(m.description)}`,
      ]);
    }
  }

  // Joins from foreign entities.
  const pairs = crossSchemaPairs(source);
  for (const j of semantic.joins) {
    const label = `${j.from} -> ${j.to}`;
    if (hidden("join", label)) continue;
    const a = placed.get(j.from);
    const b = placed.get(j.to);
    if (!a || !b) {
      continue;
    }
    const col = (p: Placed, e: string) => (BARE.test(e.trim()) ? p.table.columns.find((c) => c.name.toLowerCase() === e.trim().toLowerCase())?.name : undefined);
    const [from, to] = [col(a, j.from_expr), col(b, j.to_expr)];
    if (!from || !to) {
      skip("join", label, `its keys (${clean(j.from_expr)} = ${clean(j.to_expr)}) are not plain columns of both tables in the snapshot; add the join by hand with semlayer add-join.`);
      continue;
    }
    if ((a.model.joins ?? []).some((x) => x.to === b.model.model && x.keys.length === 1 && x.keys[0]!.from.toLowerCase() === from.toLowerCase() && x.keys[0]!.to.toLowerCase() === to.toLowerCase())) {
      skip("join", `${a.model.model}.${clean(j.entity)}`, `${a.model.model} already joins ${b.model.model} on these keys; it stays as it is.`, true);
      continue;
    }
    if (!free("join", a, j.entity)) continue;
    const ignored = [...ignoredReads(a.model, input.models, [from]), ...ignoredReads(b.model, input.models, [to])];
    if (ignored.length) {
      skip("join", label, `its keys read ${ignored.map((r) => r.column).join(", ")}, in ignored_columns (left out on purpose).`);
      continue;
    }
    const shape = schemaJoin(snapshot, String(a.model.table), String(b.model.table), [{ from, to }]);
    if (shape && crossSchemaLevel(pairs, shape, "draft")) {
      const pair = pairOriented(pairs, shape);
      skip(
        "join",
        label,
        `it ${undeclaredJoinText(shape)}. Ask the owner whether the layer joins these schemas; if yes, record the pair with ${addPairCommand(src, shape, pairs)} ` +
          `and approve it on their yes (semlayer approve --target schema-pair:${src}:${pair.fromSchema}:${pair.toSchema}), then import again.`,
      );
      continue;
    }
    a.used.add(j.entity);
    push("join", `${src}.${a.model.model}.${j.entity}`, j.entity, [
      "add-join", `--source=${src}`, `--model=${a.model.model}`, `--name=${j.entity}`, `--to=${b.model.model}`, `--keys=${from}=${to}`,
      "--relationship=many_to_one", "--origin=inferred",
      `--description=${describe(`Foreign entity ${j.entity} of ${j.from} matches the primary entity of ${j.to}`)}`,
    ]);
  }

  // Metrics. The layer name of each simple metric, by dbt metric name.
  const reads = new Map<string, { model: string; measure: string }>();
  const waiting = new Set<string>();
  const metricNames = new Set(input.metricNames);
  for (const m of semantic.metrics) {
    if (hidden("metric", m.name)) continue;
    if (metricNames.has(m.name)) {
      skip("metric", m.name, "metrics.yaml already has a metric of that name; it stays as it is.", true);
      continue;
    }
    if (m.kind !== "simple") continue;
    const p = placed.get(m.measure!.model);
    const meas = p?.sm.measures.find((x) => x.name === m.measure!.name);
    if (!p) {
      // Its model is listed as not drafted (or outside the snapshot); the metric waits for it.
      waiting.add(m.name);
      continue;
    }
    if (!meas) {
      skip("metric", m.name, `its measure ${clean(m.measure!.name)} was not read from the manifest; add the metric by hand with semlayer add-metric.`);
      continue;
    }
    const texts = [...m.filters, ...m.measure!.filters];
    if (!texts.length) {
      const have = (p.model.measures ?? []).find((x) => x.name === meas.name);
      // A measure of the same name that already says the same thing is the one the metric reads.
      if (have && have.agg === meas.agg && (have.expr ?? "").trim() === (meas.expr ?? "").trim() && !have.filter && !have.segments?.length) reads.set(m.name, { model: p.model.model, measure: have.name });
      else if (have) skip("metric", m.name, `${p.model.model} already has a measure ${clean(meas.name)} that is not the same (aggregation or expression differ); it stays as it is, and the metric is not imported.`, true);
      else if (p.measures.has(meas.name) && result.items.some((i) => i.ref === `${src}.${p.model.model}.${meas.name}`)) reads.set(m.name, { model: p.model.model, measure: meas.name });
      else skip("metric", m.name, `its measure ${clean(meas.name)} was not imported (see above), so the metric has nothing to read; add the metric by hand with semlayer add-metric.`);
      continue;
    }
    // Filtered: a measure of the metric's own name with the filter in its filter key.
    const columns: Record<string, string> = {};
    for (const [dim, sql] of p.dims) for (const prefix of [p.sm.name, ...p.sm.entities.filter((e) => e.type === "primary" || e.type === "unique").map((e) => e.name)]) columns[`${prefix}__${dim}`] = sql;
    const parts: string[] = [];
    let why: string | undefined;
    for (const t of texts) {
      const r = translateDbtFilter(t, columns);
      if ("sql" in r) parts.push(r.sql);
      else {
        why = r.skipped;
        break;
      }
    }
    if (why) {
      skip("metric", m.name, `its filter was not imported: ${clean(why)}. Add the measure by hand with semlayer add-field ${src}.${p.model.model} --kind measure --filter "<sql>" once the owner says what the filter means.`);
      continue;
    }
    if (!free("metric", p, m.name)) continue;
    const filter = parts.length === 1 ? parts[0]! : parts.map((x) => `(${x})`).join(" and ");
    const bad = (meas.expr?.trim() ? problem(p, meas.expr, "measure expr") : undefined) ?? (readsText(source.dialect) ? sqlTextProblem(filter, "measure filter") : undefined);
    if (bad) {
      skip("metric", m.name, `${bad}; add the metric by hand with semlayer add-field.`);
      continue;
    }
    const reading = ignoredReads(p.model, input.models, [filter]);
    if (reading.length) {
      skip("metric", m.name, `its filter reads ${reading.map((r) => r.column).join(", ")}, in ignored_columns (left out on purpose).`);
      continue;
    }
    p.used.add(m.name);
    reads.set(m.name, { model: p.model.model, measure: m.name });
    push("measure", `${src}.${p.model.model}.${m.name}`, m.name, [
      "add-field", `${src}.${p.model.model}`, "--kind=measure", `--name=${m.name}`, `--agg=${meas.agg}`,
      ...(meas.expr?.trim() ? [`--expr=${meas.expr}`] : []), `--filter=${filter}`, `--description=${describe(m.description ?? meas.description)}`,
    ]);
  }
  // The measures above are fields; ratio and derived metrics follow them.
  for (const m of semantic.metrics) {
    if (m.kind === "simple" || hidden("metric", m.name) || metricNames.has(m.name)) continue;
    const refs = m.kind === "ratio" ? [m.numerator!, m.denominator!] : m.inputs!;
    if (!NAME_PATTERN.test(m.name)) {
      skip("metric", m.name, `"${clean(m.name)}" is not a layer name (lowercase letters, digits and underscores, starting with a letter); add it by hand under a name that is, with semlayer add-metric.`);
      continue;
    }
    if (m.filters.length) {
      skip("metric", m.name, `a filter on a ${m.kind} metric is not imported; add the metric by hand with semlayer add-metric once the owner says what the filter means.`);
      continue;
    }
    if (refs.some((r) => waiting.has(r.name))) continue;
    const unread = refs.find((r) => r.filters.length || !reads.has(r.name));
    if (unread) {
      skip(
        "metric",
        m.name,
        unread.filters.length
          ? `its input ${clean(unread.name)} carries a filter, which is not imported on an input; add the metric by hand with semlayer add-metric.`
          : semantic.metrics.some((x) => x.name === unread.name && x.kind === "simple")
            ? `it reads ${clean(unread.name)}, which was skipped above (see its reason); add the metric by hand with semlayer add-metric.`
            : `it reads ${clean(unread.name)}, which was not imported as a measure (only simple metrics become measures); add the metric by hand with semlayer add-metric.`,
      );
      continue;
    }
    const at = (name: string) => `${reads.get(name)!.model}.${reads.get(name)!.measure}`;
    const base = ["add-metric", `--name=${m.name}`, `--source=${src}`];
    let words: string[];
    if (m.kind === "ratio") {
      words = [...base, "--type=ratio", `--numerator=${at(m.numerator!.name)}`, `--denominator=${at(m.denominator!.name)}`];
    } else {
      const by = new Map(refs.map((r) => [r.alias ?? r.name, r.name]));
      let unknown: string | undefined;
      const expr = m.expr!.replace(/(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*/g, (w) => {
        const dbt = by.get(w);
        if (dbt === undefined) unknown ??= w;
        return dbt === undefined ? w : `{${at(dbt)}}`;
      });
      if (unknown !== undefined || !parseFormula(expr)) {
        skip("metric", m.name, `its formula ${unknown !== undefined ? `names ${clean(unknown)}, which is not one of its inputs` : "is not +, -, *, / and parentheses over its inputs and numbers"}; add the metric by hand with semlayer add-metric --type derived.`);
        continue;
      }
      words = [...base, "--type=derived", `--expr=${expr}`];
    }
    push("metric", `metric:${m.name}`, m.name, [...words, `--description=${describe(m.description)}`]);
  }
  return result;
}
