// The columns of a model's table that other parts of the layer read, beyond the model's own fields,
// keys and the joins to it: another model's field reading it through joins (<join>.<column>,
// <join>.<join>.<column>), and a row filter of access.yaml on the model. sl validate warns when such
// a column is in ignored_columns, and sl status and sl draft --new-columns leave it alone.
import { columnRefs } from "./compiler/qualify.ts";
import { loadAccess } from "./project.ts";
import type { Join, Model } from "./types.ts";

// One column the layer reads, the model whose table holds it, and what reads it.
export interface LayerRead {
  model: string;
  column: string;
  by: string;
}

const same = (a: string, b: string, quoted: boolean) => (quoted ? a === b : a.toLowerCase() === b.toLowerCase());

// The model and column one column reference of an expr on `model` reads, following its joins
// within `models`, and how many joins it went through; undefined when a join it names is unknown.
export function resolveRef(model: Model, models: readonly Model[], parts: string[], quoted: boolean[]): { model: Model; column: string; quoted: boolean; hops: number } | undefined {
  let at: Model | undefined = model;
  let i = 0;
  for (; i < parts.length - 1 && at; i++) {
    const join: Join | undefined = (Array.isArray(at.joins) ? at.joins : []).find((j) => typeof j?.name === "string" && same(j.name, parts[i]!, quoted[i]!));
    if (!join) break;
    at = models.find((m) => m.model === join.to);
  }
  return at ? { model: at, column: parts[i]!, quoted: quoted[i]!, hops: i } : undefined;
}

function texts(m: Model): [string, string][] {
  const out: [string, string][] = [];
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  for (const d of list(m.dimensions)) if (typeof d?.expr === "string") out.push([`dimension ${m.model}.${d.name}`, d.expr]);
  for (const x of list(m.measures)) {
    if (typeof x?.expr === "string") out.push([`measure ${m.model}.${x.name}`, x.expr]);
    if (typeof x?.filter === "string") out.push([`the filter of measure ${m.model}.${x.name}`, x.filter]);
  }
  return out;
}

// What reads each column through joins or a row filter. `rowFilters` are access.yaml's on this
// source's models: the model's name, the text (an expr or a hierarchy column) and the role.
export function layerReads(models: readonly Model[], rowFilters: readonly { model: string; text: string; role: string }[] = []): LayerRead[] {
  const out: LayerRead[] = [];
  const add = (m: Model, column: string, by: string) => {
    if (!out.some((r) => r.model === m.model && r.column.toLowerCase() === column.toLowerCase())) out.push({ model: m.model, column, by });
  };
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    for (const [by, text] of texts(m))
      for (const ref of columnRefs(text)) {
        if (ref.parts.length < 2) continue;
        const r = resolveRef(m, models, ref.parts, ref.quoted);
        if (r && r.hops > 0) add(r.model, r.column, by);
      }
  }
  for (const rf of rowFilters) {
    const m = models.find((x) => x?.model === rf.model);
    if (!m) continue;
    for (const ref of columnRefs(rf.text)) {
      const r = resolveRef(m, models, ref.parts, ref.quoted);
      if (r) add(r.model, r.column, `a row filter of role ${rf.role}`);
    }
  }
  return out;
}

// access.yaml's row filters on the models of `source`, as layerReads takes them.
export function sourceRowFilters(access: unknown, source: string): { model: string; text: string; role: string }[] {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const roles = obj(access).roles;
  const out: { model: string; text: string; role: string }[] = [];
  for (const raw of Array.isArray(roles) ? roles : []) {
    const role = obj(raw);
    for (const f of Array.isArray(role.row_filters) ? role.row_filters : []) {
      const rf = obj(f);
      const m = typeof rf.model === "string" ? /^([^.]+)\.([^.]+)$/.exec(rf.model.trim()) : null;
      if (!m || m[1] !== source) continue;
      for (const text of [rf.expr, obj(rf.hierarchy).column]) if (typeof text === "string") out.push({ model: m[2]!, text, role: String(role.name) });
    }
  }
  return out;
}

// sourceRowFilters of the project's access.yaml; none when it is missing or cannot be read (sl validate reports that).
export function accessRowFilters(root: string, source: string): { model: string; text: string; role: string }[] {
  try {
    return sourceRowFilters(loadAccess(root), source);
  } catch {
    return [];
  }
}
