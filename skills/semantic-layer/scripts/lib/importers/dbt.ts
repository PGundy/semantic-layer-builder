// Builds snapshot tables from a dbt manifest.json (schema v10 to v12) and,
// optionally, catalog.json. Models, seeds, snapshots and sources become tables;
// generic tests and contract constraints become keys.
import { UserError } from "../errors.ts";
import type { ForeignKey, SnapshotColumn, SnapshotTable, TableKind } from "../types.ts";
import { type ImportResult, kindFromTableType, schemaNamer } from "./information-schema.ts";

type Obj = Record<string, unknown>;

const TABLE_TYPES = new Set(["model", "seed", "snapshot"]);

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
}

function parseJson(content: string, label: string): Obj {
  try {
    return obj(JSON.parse(content));
  } catch (e) {
    throw new UserError(`${label}: invalid JSON: ${(e as Error).message}`);
  }
}

// Splits a rendered relation name such as "db"."schema"."table" or `p`.`d`.`t` into parts.
export function splitRelationName(rel: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < rel.length) {
    const ch = rel[i]!;
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let part = "";
      while (j < rel.length) {
        if (rel[j] === close) {
          if (rel[j + 1] === close && close !== "]") {
            part += close;
            j += 2;
            continue;
          }
          break;
        }
        part += rel[j];
        j++;
      }
      parts.push(part);
      i = j + 1;
    } else if (ch === ".") {
      i++;
    } else {
      let j = i;
      while (j < rel.length && rel[j] !== ".") j++;
      parts.push(rel.slice(i, j).trim());
      i = j;
    }
  }
  return parts.filter((p) => p !== "");
}

type Ref = { kind: "ref"; pkg: string | null; name: string; version: string | null } | { kind: "source"; source: string; table: string };

// Reads ref('x'), ref('pkg', 'x'), ref('x', v=2) or source('s', 't'), with or without {{ }}.
export function parseRefExpr(expr: string): Ref | null {
  const m = expr.match(/\b(ref|source)\s*\(([^)]*)\)/);
  if (!m) return null;
  const args = m[2]!;
  const positional = [...args.matchAll(/(?:^|,)\s*(?:(\w+)\s*=\s*)?(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g)].map((a) => ({
    key: a[1] ?? null,
    value: a[2] ?? a[3] ?? a[4] ?? "",
  }));
  const plain = positional.filter((a) => a.key === null).map((a) => a.value);
  if (m[1] === "source") {
    if (plain.length < 2) return null;
    return { kind: "source", source: plain[0]!, table: plain[1]! };
  }
  const version = positional.find((a) => a.key === "v" || a.key === "version")?.value ?? null;
  if (plain.length === 1) return { kind: "ref", pkg: null, name: plain[0]!, version };
  if (plain.length >= 2) return { kind: "ref", pkg: plain[0]!, name: plain[1]!, version };
  return null;
}

interface NodeTable {
  id: string;
  node: Obj;
  table: SnapshotTable;
  catalog: string | null;
  // Column name lookups by lowercase name.
  cols: Map<string, SnapshotColumn>;
  notNull: Set<string>;
  unique: Set<string>;
  uniqueCombos: string[][];
  pk: string[] | null;
  fks: ForeignKey[];
  // True when catalog.json listed this relation's columns, so they are complete.
  complete: boolean;
}

function kindForNode(node: Obj, catalogType: string | null): TableKind {
  if (catalogType) return kindFromTableType(catalogType);
  if (node.resource_type === "source") return Object.keys(obj(node.external)).length ? "external" : "table";
  const mat = s(obj(node.config).materialized) ?? "table";
  if (mat === "view" || mat === "materialized_view") return "view";
  return "table";
}

export function importDbt(manifestText: string, catalogText?: string, labels = { manifest: "manifest.json", catalog: "catalog.json" }): ImportResult {
  const manifest = parseJson(manifestText, labels.manifest);
  const nodes = obj(manifest.nodes);
  const sources = obj(manifest.sources);
  if (!Object.keys(nodes).length && !Object.keys(sources).length) {
    throw new UserError(`${labels.manifest}: no "nodes" or "sources"; this does not look like a dbt manifest.json (run \`dbt compile\` or \`dbt docs generate\`).`);
  }
  const version = s(obj(manifest.metadata).dbt_schema_version)?.match(/manifest\/v(\d+)/)?.[1];
  const warnings: string[] = [];
  if (version && (Number(version) < 10 || Number(version) > 12)) {
    warnings.push(`Manifest schema v${version}; this importer reads v10 to v12, so some fields may be missed.`);
  }
  const catalog = catalogText === undefined ? null : parseJson(catalogText, labels.catalog);
  const catalogEntries: Obj = catalog ? { ...obj(catalog.nodes), ...obj(catalog.sources) } : {};

  // Collect relations.
  const entries: [string, Obj][] = [
    ...Object.entries(nodes).filter(([, n]) => TABLE_TYPES.has(String(obj(n).resource_type))),
    ...Object.entries(sources),
  ].map(([id, n]) => [id, obj(n)]);

  const raw: { id: string; node: Obj; catalog: string | null; schema: string | null; name: string }[] = [];
  let ephemeral = 0;
  for (const [id, node] of entries) {
    const mat = s(obj(node.config).materialized);
    if (mat === "ephemeral") {
      ephemeral++;
      continue;
    }
    if (obj(node.config).enabled === false) continue;
    const rel = s(node.relation_name);
    let database = s(node.database);
    let schema = s(node.schema);
    let name = node.resource_type === "source" ? (s(node.identifier) ?? s(node.name)) : (s(node.alias) ?? s(node.name));
    if (rel) {
      const parts = splitRelationName(rel);
      if (parts.length >= 1) name = parts[parts.length - 1]!;
      if (parts.length >= 2) schema = parts[parts.length - 2]!;
      if (parts.length >= 3) database = parts[parts.length - 3]!;
    }
    const cat = obj(obj(catalogEntries[id]).metadata);
    if (!rel && s(cat.name)) {
      name = s(cat.name);
      schema = s(cat.schema) ?? schema;
      database = s(cat.database) ?? database;
    }
    if (!name) {
      warnings.push(`Skipped ${id}: no relation name.`);
      continue;
    }
    raw.push({ id, node, catalog: database, schema, name });
  }
  if (ephemeral) warnings.push(`Skipped ${ephemeral} ephemeral model${ephemeral === 1 ? "" : "s"} (no table in the warehouse).`);

  const namer = schemaNamer(raw.map((r) => r.catalog));
  const byId = new Map<string, NodeTable>();
  let untyped = 0;
  let undocumentedInCatalog = 0;
  for (const r of raw) {
    const centry = obj(catalogEntries[r.id]);
    const cmeta = obj(centry.metadata);
    const stats = obj(centry.stats);
    const rowStat = obj(stats.row_count ?? stats.num_rows);
    const rowCount = typeof rowStat.value === "number" ? rowStat.value : typeof rowStat.value === "string" && /^\d+$/.test(rowStat.value) ? Number(rowStat.value) : null;
    const table: SnapshotTable = {
      schema: namer(r.catalog, r.schema),
      name: r.name,
      kind: kindForNode(r.node, s(cmeta.type)),
      row_count: rowCount,
      description: s(r.node.description) ?? s(cmeta.comment),
      primary_key: [],
      unique_keys: [],
      foreign_keys: [],
      columns: [],
    };
    const docCols = Object.values(obj(r.node.columns)).map(obj);
    const docByLower = new Map(docCols.filter((c) => s(c.name)).map((c) => [s(c.name)!.toLowerCase(), c]));
    const catCols = Object.values(obj(centry.columns))
      .map(obj)
      .filter((c) => s(c.name))
      .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    const cols: SnapshotColumn[] = [];
    const used = new Set<string>();
    for (const c of catCols) {
      const name = s(c.name)!;
      const doc = docByLower.get(name.toLowerCase());
      used.add(name.toLowerCase());
      cols.push({ name, type: s(c.type) ?? s(doc?.data_type) ?? "unknown", nullable: null, description: s(doc?.description) ?? s(c.comment) });
    }
    for (const doc of docCols) {
      const name = s(doc.name);
      if (!name || used.has(name.toLowerCase())) continue;
      used.add(name.toLowerCase());
      if (catCols.length) undocumentedInCatalog++;
      const type = s(doc.data_type);
      if (!type) untyped++;
      cols.push({ name, type: type ?? "unknown", nullable: null, description: s(doc.description) });
    }
    table.columns = cols;
    byId.set(r.id, {
      id: r.id,
      node: r.node,
      table,
      catalog: r.catalog,
      cols: new Map(cols.map((c) => [c.name.toLowerCase(), c])),
      notNull: new Set(),
      unique: new Set(),
      uniqueCombos: [],
      pk: null,
      fks: [],
      complete: catCols.length > 0,
    });
  }
  if (catalog && undocumentedInCatalog) {
    warnings.push(`${undocumentedInCatalog} documented column${undocumentedInCatalog === 1 ? " is" : "s are"} missing from catalog.json; kept from the manifest.`);
  }

  // Resolves a ref() or source() to a collected relation.
  const resolve = (ref: Ref, fromPkg: string | null): NodeTable | undefined => {
    const all = [...byId.values()];
    if (ref.kind === "source") {
      return all.find((t) => t.node.resource_type === "source" && t.node.source_name === ref.source && t.node.name === ref.table);
    }
    const candidates = all.filter(
      (t) => TABLE_TYPES.has(String(t.node.resource_type)) && t.node.name === ref.name && (!ref.pkg || t.node.package_name === ref.pkg),
    );
    if (candidates.length <= 1) return candidates[0];
    if (ref.version) return candidates.find((t) => String(t.node.version) === ref.version);
    const latest = candidates.find((t) => t.node.latest_version !== undefined && String(t.node.version) === String(t.node.latest_version));
    return latest ?? candidates.find((t) => t.node.package_name === fromPkg) ?? candidates[0];
  };

  // Finds a column on a table by name. Without catalog columns, a column a test names is added.
  const column = (t: NodeTable, raw: string | null): string | null => {
    if (!raw) return null;
    const name = raw.trim().replace(/^["`\[]|["`\]]$/g, "");
    const hit = t.cols.get(name.toLowerCase());
    if (hit) return hit.name;
    if (t.complete || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return null;
    const col: SnapshotColumn = { name, type: "unknown", nullable: null, description: null };
    t.table.columns.push(col);
    t.cols.set(name.toLowerCase(), col);
    untyped++;
    return name;
  };

  const relRef = (target: NodeTable) => ({ schema: target.table.schema, table: target.table.name });
  let unresolved = 0;
  let unmatchedKeyTests = 0;

  // Generic tests.
  for (const raw of Object.values(nodes)) {
    const test = obj(raw);
    if (test.resource_type !== "test") continue;
    if (obj(test.config).enabled === false) continue;
    const meta = obj(test.test_metadata);
    const testName = s(meta.name);
    if (!testName) continue;
    const kwargs = obj(meta.kwargs);
    let owner: NodeTable | undefined;
    const attached = s(test.attached_node);
    if (attached) owner = byId.get(attached);
    if (!owner && s(kwargs.model)) {
      const ref = parseRefExpr(String(kwargs.model));
      if (ref) owner = resolve(ref, s(test.package_name));
    }
    if (!owner) {
      const deps = strings(obj(test.depends_on).nodes).filter((d) => byId.has(d));
      if (deps.length === 1) owner = byId.get(deps[0]!);
    }
    if (!owner) continue;
    const colName = column(owner, s(kwargs.column_name) ?? s(test.column_name));
    switch (testName) {
      case "unique":
        if (colName) owner.unique.add(colName);
        else unmatchedKeyTests++;
        break;
      case "not_null":
        if (colName) owner.notNull.add(colName);
        else unmatchedKeyTests++;
        break;
      case "unique_combination_of_columns": {
        const names = strings(kwargs.combination_of_columns);
        const combo = names.map((c) => column(owner, c)).filter((c): c is string => !!c);
        if (combo.length && combo.length === names.length) owner.uniqueCombos.push(combo);
        else unmatchedKeyTests++;
        break;
      }
      case "relationships": {
        const to = s(kwargs.to);
        const ref = to ? parseRefExpr(to) : null;
        const target = ref ? resolve(ref, s(test.package_name)) : undefined;
        const field = s(kwargs.field);
        if (!colName || !target || !field) {
          unresolved++;
          break;
        }
        const targetCol = column(target, field);
        if (!targetCol) {
          unresolved++;
          break;
        }
        owner.fks.push({ columns: [colName], references: { ...relRef(target), columns: [targetCol] } });
        break;
      }
    }
  }

  // Contract constraints (dbt 1.5+), on the model and on its columns.
  const constraintFk = (t: NodeTable, columns: string[], c: Obj) => {
    const to = s(c.to);
    let target: NodeTable | undefined;
    if (to) {
      const ref = parseRefExpr(to);
      if (ref) target = resolve(ref, s(t.node.package_name));
    }
    let toCols = strings(c.to_columns);
    const expr = s(c.expression);
    if (!target && expr) {
      const m = expr.match(/^\s*([^\s(]+)\s*\(([^)]*)\)/);
      if (m) {
        const parts = splitRelationName(m[1]!);
        const name = parts[parts.length - 1]?.toLowerCase();
        const schema = parts.length >= 2 ? parts[parts.length - 2]!.toLowerCase() : null;
        target = [...byId.values()].find(
          (x) => x.table.name.toLowerCase() === name && (schema === null || (x.table.schema ?? "").toLowerCase().endsWith(schema)),
        );
        if (!toCols.length) toCols = m[2]!.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }
    if (!target || !toCols.length || toCols.length !== columns.length) {
      unresolved++;
      return;
    }
    const resolved = toCols.map((x) => column(target, x)).filter((x): x is string => !!x);
    if (resolved.length !== columns.length) {
      unresolved++;
      return;
    }
    t.fks.push({ columns, references: { ...relRef(target), columns: resolved } });
  };
  for (const t of byId.values()) {
    for (const raw of Array.isArray(t.node.constraints) ? t.node.constraints : []) {
      const c = obj(raw);
      const cols = strings(c.columns).map((x) => column(t, x)).filter((x): x is string => !!x);
      if (!cols.length) continue;
      if (c.type === "primary_key") t.pk = cols;
      else if (c.type === "unique") t.uniqueCombos.push(cols);
      else if (c.type === "foreign_key") constraintFk(t, cols, c);
    }
    for (const rawCol of Object.values(obj(t.node.columns))) {
      const colDoc = obj(rawCol);
      const name = column(t, s(colDoc.name));
      if (!name) continue;
      for (const raw of Array.isArray(colDoc.constraints) ? colDoc.constraints : []) {
        const c = obj(raw);
        if (c.type === "primary_key") t.pk = [name];
        else if (c.type === "unique") t.unique.add(name);
        else if (c.type === "not_null") t.notNull.add(name);
        else if (c.type === "foreign_key") constraintFk(t, [name], c);
      }
    }
  }
  if (unmatchedKeyTests) {
    warnings.push(
      `${unmatchedKeyTests} unique, not_null or unique_combination_of_columns test${unmatchedKeyTests === 1 ? " names a column" : "s name columns"} not found on the tested table and ${unmatchedKeyTests === 1 ? "was" : "were"} not read as a key.`,
    );
  }
  if (unresolved) warnings.push(`${unresolved} relationship test${unresolved === 1 ? "" : "s"} or foreign key constraint${unresolved === 1 ? "" : "s"} could not be resolved to a table and column.`);

  // Keys and nullability.
  const tables: SnapshotTable[] = [];
  for (const t of byId.values()) {
    for (const name of t.notNull) {
      const c = t.cols.get(name.toLowerCase());
      if (c) c.nullable = false;
    }
    const order = t.table.columns.map((c) => c.name);
    const candidates = order.filter((c) => t.unique.has(c) && t.notNull.has(c));
    const pk = t.pk ?? (candidates.length ? [candidates[0]!] : []);
    t.table.primary_key = pk;
    const keyOf = (k: string[]) => k.map((x) => x.toLowerCase()).join("\u0000");
    const seen = new Set<string>([keyOf(pk)]);
    const unique: string[][] = [];
    for (const k of [...order.filter((c) => t.unique.has(c)).map((c) => [c]), ...t.uniqueCombos]) {
      if (seen.has(keyOf(k))) continue;
      seen.add(keyOf(k));
      unique.push(k);
    }
    t.table.unique_keys = unique;
    const fkSeen = new Set<string>();
    t.table.foreign_keys = t.fks.filter((fk) => {
      const k = JSON.stringify(fk);
      if (fkSeen.has(k)) return false;
      fkSeen.add(k);
      return true;
    });
    tables.push(t.table);
  }
  if (untyped) {
    warnings.push(
      `${untyped} column${untyped === 1 ? " has" : "s have"} no type${catalog ? "" : "; pass --catalog target/catalog.json (from `dbt docs generate`) for types and row counts"}.`,
    );
  }
  return { tables, warnings };
}
