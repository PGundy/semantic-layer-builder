// sl rename <source.model> <new_name>: every place outside the model's own file name that names a
// model, for a rename that moves models/<source>/<model>.yaml to <new_name>.yaml in one write.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RefSite } from "./edit.ts";
import { pathText } from "./edit.ts";
import { matchesDotted } from "./patterns.ts";
import { paths } from "./project.ts";
import type { Model } from "./types.ts";
import { readYamlIfExists } from "./yaml.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// The places that name model `from` of `source`, each with its text after the rename to `to`: the
// model key of its own file; `to` and `evidence.to` of every join to it in the source's models;
// model.measure references in metrics.yaml; model.field references in the requests of goldens in its
// source; and in access.yaml, row filters' `model` and `hierarchy.via` and each entry of allow.models,
// deny.models, deny.fields and restriction targets that names it or one of its fields (a pattern whose
// first two parts are the source and the model keeps the rest as written). `conflicts` lists the
// access patterns that would make a list cover the model or one of its fields differently under the
// new name, which a rename would silently change.
export function modelReferenceSites(root: string, source: string, from: string, to: string, fields: string[]): { sites: RefSite[]; conflicts: string[] } {
  const sites: RefSite[] = [];
  const conflicts: string[] = [];
  const add = (file: string, path: (string | number)[], was: unknown, now: string) => {
    if (typeof was === "string" && was !== now) sites.push({ file, path, from: was, to: now });
  };
  const own = paths(root).model(source, from);
  sites.push({ file: own, path: ["model"], from, to });

  const dir = paths(root).modelsDir(source);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort() : []) {
    const file = join(dir, f);
    const m = obj(readYamlIfExists<Model>(file));
    arr(m.joins).forEach((raw, i) => {
      const j = obj(raw);
      if (j.to === from) add(file, ["joins", i, "to"], j.to, to);
      if (obj(j.evidence).to === from) add(file, ["joins", i, "evidence", "to"], from, to);
    });
  }

  // model.field, with an optional :grain, as metrics and golden requests write it.
  const dotted = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const m = /^(\s*)([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*(?::[a-z]+)?\s*)$/.exec(value);
    return m && m[2] === from ? `${m[1]}${to}.${m[3]}` : undefined;
  };
  const metricsFile = paths(root).metrics;
  arr(readYamlIfExists<Obj>(metricsFile)?.metrics).forEach((raw, i) => {
    const m = obj(raw);
    if (m.source !== source) return;
    for (const k of ["numerator", "denominator"]) {
      const now = dotted(m[k]);
      if (now !== undefined) add(metricsFile, ["metrics", i, k], m[k], now);
    }
    if (typeof m.expr === "string") {
      const now = m.expr.replace(/\{(\s*)([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(\s*)\}/g, (all, a: string, model: string, measure: string, b: string) =>
        model === from ? `{${a}${to}.${measure}${b}}` : all,
      );
      add(metricsFile, ["metrics", i, "expr"], m.expr, now);
    }
  });

  const goldens = paths(root).goldensDir;
  for (const f of existsSync(goldens) ? readdirSync(goldens).filter((x) => x.endsWith(".yaml") || x.endsWith(".yml")).sort() : []) {
    const file = join(goldens, f);
    let request: Obj;
    try {
      request = obj(obj(readYamlIfExists<unknown>(file)).request);
    } catch {
      continue;
    }
    if (request.source !== source) continue;
    const check = (path: (string | number)[], value: unknown) => {
      const now = dotted(value);
      if (now !== undefined) add(file, path, value, now);
    };
    for (const key of ["measures", "dimensions"]) arr(request[key]).forEach((v, i) => check(["request", key, i], v));
    for (const key of ["filters", "order_by"]) arr(request[key]).forEach((v, i) => check(["request", key, i, "field"], obj(v).field));
  }

  // access.yaml, read as sl access reads it: names compare in any case, patterns as scope patterns.
  const accessFile = paths(root).access;
  const access = obj(readYamlIfExists<unknown>(accessFile));
  const oldModel = `${source}.${from}`;
  const newModel = `${source}.${to}`;
  const exact = (path: (string | number)[], value: unknown) => {
    if (typeof value === "string" && value.trim().toLowerCase() === oldModel) add(accessFile, path, value, newModel);
  };
  // An entry renamed with the model: one whose first two parts are its source and name, outside re:.
  const renamedEntry = (t: string): string => {
    const lower = t.toLowerCase();
    if (t.startsWith("re:") || (lower !== oldModel && !lower.startsWith(`${oldModel}.`))) return t;
    return newModel + t.slice(oldModel.length);
  };
  const matches = (p: string, subject: string) => {
    try {
      return matchesDotted(p, subject);
    } catch {
      return false;
    }
  };
  const subjects = { models: [[oldModel, newModel]], fields: fields.map((n) => [`${oldModel}.${n}`, `${newModel}.${n}`]) };
  const patternList = (base: (string | number)[], raw: unknown, kinds: ("models" | "fields")[], prefixed: boolean) => {
    const entries: [(string | number)[], unknown][] = prefixed && typeof raw === "string" ? [[base, raw]] : arr(raw).map((t, k) => [[...base, k], t]);
    const list: { path: (string | number)[]; was: string; now: string }[] = [];
    for (const [path, t] of entries) {
      if (typeof t !== "string" || (prefixed && t.startsWith("metric:"))) continue;
      const now = renamedEntry(t);
      add(accessFile, path, t, now);
      list.push({ path, was: t, now });
    }
    for (const [was, now] of kinds.flatMap((k) => subjects[k])) {
      const before = list.some((e) => matches(e.was, was!));
      const after = list.some((e) => matches(e.now, now!));
      if (before === after) continue;
      for (const e of list) {
        const b = matches(e.was, was!);
        if (b !== matches(e.now, now!)) conflicts.push(`access.yaml ${pathText(e.path)}: ${e.was} matches ${b ? was : now} but not ${b ? now : was}`);
      }
    }
  };
  arr(access.restrictions).forEach((r, i) => patternList(["restrictions", i, "targets"], obj(r).targets, ["models", "fields"], true));
  arr(access.roles).forEach((raw, i) => {
    const role = obj(raw);
    patternList(["roles", i, "allow", "models"], obj(role.allow).models, ["models"], false);
    patternList(["roles", i, "deny", "models"], obj(role.deny).models, ["models"], false);
    patternList(["roles", i, "deny", "fields"], obj(role.deny).fields, ["fields"], false);
    arr(role.row_filters).forEach((rf, k) => {
      exact(["roles", i, "row_filters", k, "model"], obj(rf).model);
      exact(["roles", i, "row_filters", k, "hierarchy", "via"], obj(obj(rf).hierarchy).via);
    });
  });
  return { sites, conflicts: [...new Set(conflicts)] };
}
