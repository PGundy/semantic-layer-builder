// Loading scenarios and scripts, reading a semantic root, and writing deterministic JSON.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evalSchemaIssues, type EvalSchemaKind } from "../../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { AGENT_ROLES, type AgentRole, EvalError, type Scenario } from "./types.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const SCENARIOS_DIR = join(REPO_ROOT, "evals", "scenarios");
export const PERSONAS_DIR = join(import.meta.dir, "personas");

export interface ScriptTurn {
  text: string;
  tokens?: number;
  sl?: string[][];
  // Files the skill writes by hand, by path relative to the working root, before its sl commands run.
  write?: Record<string, string>;
  done?: boolean;
  // A task the interviewer turn before it dispatched to this role agent (multi-agent scenarios).
  agent?: AgentRole;
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
  const problem = agentTurnProblem(scenario, script);
  if (problem) throw new EvalError(`${relative(REPO_ROOT, path)}: ${problem}`);
  for (const turn of script.skill) {
    for (const [file, text] of Object.entries(turn.write ?? {})) {
      const problem = scriptWriteProblem(file, text);
      if (problem) throw new EvalError(`${relative(REPO_ROOT, path)}: ${problem}`);
    }
    for (const args of turn.sl ?? []) {
      if (args.some((a) => a === "--root" || a.startsWith("--root="))) {
        throw new EvalError(`${relative(REPO_ROOT, path)}: an sl command passes --root; the driver runs every command in the run's working root, so remove it.`);
      }
    }
  }
  return script;
}

// Why a script's role-agent turns cannot run, or undefined: they need a multi-agent scenario, follow
// the interviewer turn that dispatched them, write no file (role agents edit none) and never end the session.
export function agentTurnProblem(scenario: Scenario, script: Script): string | undefined {
  const at = script.skill.findIndex((t) => t.agent !== undefined);
  if (at < 0) return undefined;
  if (scenario.agents !== "multi") return `skill turn ${at + 1} is a ${script.skill[at]!.agent} task, but scenario ${scenario.name} is not multi-agent; set "agents": "multi" in it or remove the agent turns.`;
  if (at === 0) return `skill turn 1 is a ${script.skill[0]!.agent} task, but no interviewer turn before it dispatched it; start with an interviewer turn.`;
  for (const [i, t] of script.skill.entries()) {
    if (t.agent === undefined) continue;
    if (!AGENT_ROLES.includes(t.agent)) return `skill turn ${i + 1} names agent "${t.agent}"; use one of ${AGENT_ROLES.join(", ")}.`;
    if (t.write) return `skill turn ${i + 1} is a ${t.agent} task that writes files; role agents edit no files, so move the write to the interviewer's turn.`;
    if (t.done !== undefined) return `skill turn ${i + 1} is a ${t.agent} task with "done"; only the interviewer ends the session, so move it to an interviewer turn.`;
  }
  return undefined;
}

// Keys only sl approve and sl goldens confirm write; a hand write that holds one would pose as an approval.
const APPROVAL_KEYS = ["approved_by", "approved_at", "approved_hash", "last_approved", "confirmed_by", "confirmed_at", "confirmed_as"];

// Whether a parsed document sets status: approved or an approval key on any map at any depth.
function approves(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(approves);
  if (!value || typeof value !== "object") return false;
  const map = value as Record<string, unknown>;
  if (map.status === "approved" || APPROVAL_KEYS.some((k) => k in map)) return true;
  return Object.values(map).some(approves);
}

// Why a scripted hand write may not happen, or undefined. A write stays inside the working root, never
// touches .sl/ (the readbacks and the owner's answers, which only sl writes) and never approves:
// only sl approve and sl goldens confirm set status: approved. The text is judged as the CLI reads it,
// parsed as YAML (JSON included), so no spelling of status: approved gets past; text that does not
// parse is refused, since the CLI could not read it either.
export function scriptWriteProblem(file: string, text: string): string | undefined {
  const parts = file.split(/[\\/]/);
  if (isAbsolute(file) || !file.trim() || parts.some((p) => p === ".." || p === "." || p === "")) {
    return `a scripted write names "${file}"; name a file by its plain path inside the semantic root, such as goldens/<name>.yaml.`;
  }
  if (parts[0]!.toLowerCase() === ".sl") return `a scripted write names "${file}"; .sl/ holds the readbacks and the owner's answers, which only sl readback, sl reply and sl question write. Record an answer with sl reply instead.`;
  let doc: unknown;
  try {
    doc = parseYamlText(text, file);
  } catch (e) {
    return `a scripted write of "${file}" is not valid YAML (${(e as Error).message}); fix its text so sl can read it.`;
  }
  if (approves(doc)) return `a scripted write of "${file}" sets status: approved or an approval field; write it as a draft and approve it with sl approve or sl goldens confirm after the owner's recorded yes.`;
  return undefined;
}

// The absolute path a scripted write goes to, refusing one that leaves the root through a link.
export function scriptWritePath(root: string, file: string, text: string): string {
  const problem = scriptWriteProblem(file, text);
  if (problem) throw new EvalError(problem);
  const base = resolve(root);
  const target = join(base, file);
  // Every path from the target up to the root must be absent or a plain file or directory: a link at
  // any level, dangling or not, could lead out of the root.
  for (let p = target; p !== base && p.startsWith(base + sep); p = dirname(p)) {
    let linked = false;
    try {
      linked = lstatSync(p).isSymbolicLink();
    } catch {
      linked = false;
    }
    if (linked) throw new EvalError(`a scripted write of "${file}" would leave the semantic root through a link; write inside the root.`);
  }
  return target;
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
