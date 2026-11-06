// Loading scenarios and scripts, reading a semantic root, and writing deterministic JSON.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evalSchemaIssues, type EvalSchemaKind } from "../../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { EvalError, type Scenario } from "./types.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const SCENARIOS_DIR = join(REPO_ROOT, "evals", "scenarios");
export const PERSONAS_DIR = join(import.meta.dir, "personas");

export interface ScriptTurn {
  text: string;
  tokens?: number;
  sl?: string[][];
  done?: boolean;
}

export interface Script {
  skill: ScriptTurn[];
  owner: { text: string; tokens?: number }[];
}

function readStructured(path: string): unknown {
  const text = readFileSync(path, "utf8");
  const ext = extname(path);
  try {
    return ext === ".yaml" || ext === ".yml" ? parseYamlText(text, path) : JSON.parse(text);
  } catch (e) {
    throw new EvalError(`${relative(REPO_ROOT, path)} is not valid ${ext === ".json" ? "JSON" : "YAML"}: ${(e as Error).message}`);
  }
}

function checked<T>(kind: EvalSchemaKind, path: string): T {
  const data = readStructured(path);
  const issues = evalSchemaIssues(kind, data, relative(REPO_ROOT, path));
  if (issues.length) {
    throw new EvalError(`${relative(REPO_ROOT, path)} does not match its schema:\n${issues.map((i) => `  ${i.path || "(top)"} ${i.message}`).join("\n")}`);
  }
  return data as T;
}

// The scenario file for a name (evals/scenarios/<name>.json or .yaml) or a path to one.
export function scenarioPath(nameOrPath: string): string {
  if (/[\\/]/.test(nameOrPath) || /\.(json|ya?ml)$/.test(nameOrPath)) {
    const p = resolve(nameOrPath);
    if (!existsSync(p)) throw new EvalError(`No scenario file at ${nameOrPath}. List the shipped ones with: ls evals/scenarios`);
    return p;
  }
  for (const ext of [".json", ".yaml", ".yml"]) {
    const p = join(SCENARIOS_DIR, `${nameOrPath}${ext}`);
    if (existsSync(p)) return p;
  }
  const known = existsSync(SCENARIOS_DIR)
    ? readdirSync(SCENARIOS_DIR)
        .filter((f) => /^[a-z][a-z0-9-]*\.(json|ya?ml)$/.test(f))
        .map((f) => f.replace(/\.(json|ya?ml)$/, ""))
        .sort()
    : [];
  throw new EvalError(`No scenario named "${nameOrPath}". Known scenarios: ${known.join(", ") || "none"}. Run: bun evals/runner/run.ts --scenario <name>`);
}

export function loadScenario(path: string): Scenario {
  const scenario = checked<Scenario>("eval-scenario", path);
  const stem = path.slice(path.lastIndexOf(sep) + 1).replace(/\.(json|ya?ml)$/, "");
  if (scenario.name !== stem) throw new EvalError(`${relative(REPO_ROOT, path)} holds name "${scenario.name}"; a scenario's name equals its file name, "${stem}".`);
  if (!existsSync(join(PERSONAS_DIR, `${scenario.persona}.md`))) {
    throw new EvalError(`Scenario ${scenario.name} names persona "${scenario.persona}", which has no prompt in evals/runner/personas/. Add ${scenario.persona}.md there.`);
  }
  if (!existsSync(join(REPO_ROOT, "fixtures", scenario.fixture, "owner-brief.md"))) {
    throw new EvalError(`Scenario ${scenario.name} names fixture "${scenario.fixture}", which has no fixtures/${scenario.fixture}/owner-brief.md.`);
  }
  return scenario;
}

// The script for the scripted driver: --script if given, else the scenario's own.
export function loadScript(scenario: Scenario, scenarioFile: string, override?: string): Script {
  const ref = override ?? scenario.script;
  if (!ref) throw new EvalError(`Scenario ${scenario.name} has no script for the scripted driver. Pass --script <file>, or run it with --driver sdk.`);
  const path = override ? resolve(override) : isAbsolute(ref) ? ref : join(dirname(scenarioFile), ref);
  if (!existsSync(path)) throw new EvalError(`No script file at ${relative(REPO_ROOT, path)}. Pass --script <file> with one that exists.`);
  const script = checked<Script>("eval-script", path);
  for (const turn of script.skill) {
    for (const args of turn.sl ?? []) {
      if (args.some((a) => a === "--root" || a.startsWith("--root="))) {
        throw new EvalError(`${relative(REPO_ROOT, path)}: an sl command passes --root; the driver runs every command in the run's working root, so remove it.`);
      }
    }
  }
  return script;
}

// Every file under root, by forward-slash path relative to it, sorted.
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// JSON with object keys sorted at every level, so the same value always writes the same bytes.
export function stableJson(value: unknown, indent?: number): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}

// A token estimate for text that carries no count: its length divided by 4, rounded up.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
