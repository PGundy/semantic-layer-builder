import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UserError } from "./errors.ts";
import type { AccessFile, Golden, MetricsFile, Model, Project, Snapshot, SourceConfig } from "./types.ts";
import { DEFAULT_BATCH_SIZE, DEFAULT_FOCUS_THRESHOLD, NAME_PATTERN } from "./types.ts";
import { readJson, readYaml, readYamlIfExists } from "./yaml.ts";

export function resolveRoot(flag: string | undefined, env: Record<string, string | undefined>, cwd: string): string {
  return resolve(cwd, flag ?? env.SEMANTIC_ROOT ?? "semantic");
}

// Rejects a name that could escape the semantic root when used in a path.
function safe(kind: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new UserError(`${kind} "${name}" must match ^[a-z][a-z0-9_]*$.`);
  return name;
}

export function paths(root: string) {
  return {
    root,
    project: join(root, "semantic.yaml"),
    sourcesDir: join(root, "sources"),
    source: (s: string) => join(root, "sources", `${safe("Source", s)}.yaml`),
    snapshotsDir: join(root, "snapshots"),
    snapshot: (s: string) => join(root, "snapshots", `${safe("Source", s)}.json`),
    modelsDir: (s: string) => join(root, "models", safe("Source", s)),
    model: (s: string, m: string) => join(root, "models", safe("Source", s), `${safe("Model", m)}.yaml`),
    metrics: join(root, "metrics.yaml"),
    access: join(root, "access.yaml"),
    goldensDir: join(root, "goldens"),
    golden: (g: string) => join(root, "goldens", `${safe("Golden", g)}.yaml`),
  };
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

export function stem(file: string): string {
  return file.replace(/\.ya?ml$/, "");
}

export function loadProject(root: string): Project {
  const p = paths(root).project;
  if (!existsSync(p)) throw new UserError(`No semantic layer at ${root}. Run \`sl init --name <name>\` first, or pass --root.`);
  return readYaml<Project>(p);
}

export function projectSettings(project: Project) {
  return {
    focus_threshold: project.settings?.focus_threshold ?? DEFAULT_FOCUS_THRESHOLD,
    batch_size: project.settings?.batch_size ?? DEFAULT_BATCH_SIZE,
  };
}

export function listSourceNames(root: string): string[] {
  return yamlFiles(paths(root).sourcesDir).map(stem);
}

export function loadSource(root: string, name: string): SourceConfig {
  const p = paths(root).source(name);
  if (!existsSync(p)) {
    const known = listSourceNames(root);
    throw new UserError(`Unknown source "${name}". Known sources: ${known.length ? known.join(", ") : "none"}.`);
  }
  return readYaml<SourceConfig>(p);
}

export function loadSnapshot(root: string, source: string): Snapshot | null {
  const p = paths(root).snapshot(source);
  return existsSync(p) ? readJson<Snapshot>(p) : null;
}

export function requireSnapshot(root: string, source: string): Snapshot {
  const s = loadSnapshot(root, source);
  if (!s) throw new UserError(`No snapshot for "${source}". Run \`sl introspect --source ${source}\` or \`sl import\` first.`);
  return s;
}

// Tables in snapshot order: by "schema.name", compared with localeCompare. Each key is built once.
export function sortTables<T extends { schema?: string | null; name: string }>(tables: readonly T[]): T[] {
  return tables
    .map((t) => ({ t, k: `${t.schema ?? ""}.${t.name}` }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((x) => x.t);
}

// Writes the snapshot file with its tables in snapshot order. The bytes are those of
// writeJson, but the tables are serialized and written in batches, so a catalog of a million
// columns is never held as one string. They go to a file beside it that then replaces it, so a
// failed write leaves the previous snapshot whole.
export function saveSnapshot(root: string, snapshot: Snapshot): void {
  const path = paths(root).snapshot(snapshot.source);
  const tables = sortTables(snapshot.tables);
  const marker = "\u0000sl tables\u0000";
  const head = JSON.stringify({ ...snapshot, tables: marker }, null, 2);
  // Top-level keys are the only ones indented by two spaces, so this occurs once.
  const slot = `\n  "tables": ${JSON.stringify(marker)}`;
  const at = head.indexOf(slot);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  const fd = openSync(partial, "w");
  try {
    try {
      writeSync(fd, `${head.slice(0, at)}\n  "tables": ${tables.length ? "[" : "[]"}`);
      for (let i = 0; i < tables.length; i += 500) {
        const batch = tables.slice(i, i + 500).map((t) => `\n    ${JSON.stringify(t, null, 2).replaceAll("\n", "\n    ")}`);
        writeSync(fd, `${i ? "," : ""}${batch.join(",")}`);
      }
      writeSync(fd, `${tables.length ? "\n  ]" : ""}${head.slice(at + slot.length)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, path);
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
}

export interface LoadedModel {
  path: string;
  model: Model;
}

export function listModels(root: string, source?: string): LoadedModel[] {
  const sources = source ? [source] : listSourceNames(root);
  const out: LoadedModel[] = [];
  for (const s of sources) {
    const dir = paths(root).modelsDir(s);
    for (const f of yamlFiles(dir)) {
      const path = join(dir, f);
      out.push({ path, model: readYaml<Model>(path) });
    }
  }
  return out;
}

export function loadModel(root: string, source: string, model: string): LoadedModel {
  const path = paths(root).model(source, model);
  if (!existsSync(path)) throw new UserError(`No model "${model}" in source "${source}" (${path}).`);
  return { path, model: readYaml<Model>(path) };
}

export function loadMetrics(root: string): MetricsFile {
  return readYamlIfExists<MetricsFile>(paths(root).metrics) ?? { metrics: [] };
}

export function loadAccess(root: string): AccessFile | null {
  return readYamlIfExists<AccessFile>(paths(root).access);
}

export interface LoadedGolden {
  path: string;
  golden: Golden;
}

export function listGoldens(root: string): LoadedGolden[] {
  const dir = paths(root).goldensDir;
  return yamlFiles(dir).map((f) => ({ path: join(dir, f), golden: readYaml<Golden>(join(dir, f)) }));
}
