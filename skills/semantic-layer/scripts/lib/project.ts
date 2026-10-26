import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { UserError } from "./errors.ts";
import type { AccessFile, Golden, MetricsFile, Model, Project, Snapshot, SourceConfig } from "./types.ts";
import { DEFAULT_BATCH_SIZE, DEFAULT_FOCUS_THRESHOLD } from "./types.ts";
import { readJson, readYaml, readYamlIfExists, writeJson } from "./yaml.ts";

export function resolveRoot(flag: string | undefined, env: Record<string, string | undefined>, cwd: string): string {
  return resolve(cwd, flag ?? env.SEMANTIC_ROOT ?? "semantic");
}

export function paths(root: string) {
  return {
    root,
    project: join(root, "semantic.yaml"),
    sourcesDir: join(root, "sources"),
    source: (s: string) => join(root, "sources", `${s}.yaml`),
    snapshotsDir: join(root, "snapshots"),
    snapshot: (s: string) => join(root, "snapshots", `${s}.json`),
    modelsDir: (s: string) => join(root, "models", s),
    model: (s: string, m: string) => join(root, "models", s, `${m}.yaml`),
    metrics: join(root, "metrics.yaml"),
    access: join(root, "access.yaml"),
    goldensDir: join(root, "goldens"),
    golden: (g: string) => join(root, "goldens", `${g}.yaml`),
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

export function saveSnapshot(root: string, snapshot: Snapshot): void {
  const sorted: Snapshot = {
    ...snapshot,
    tables: [...snapshot.tables].sort((a, b) =>
      `${a.schema ?? ""}.${a.name}`.localeCompare(`${b.schema ?? ""}.${b.name}`),
    ),
  };
  writeJson(paths(root).snapshot(snapshot.source), sorted);
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
