// The validation seam (lib/validate-rules/): a rule file dropped into the directory is found with no
// edit to a shared file, runs once per validation after the checks of lib/validate.ts, and reports
// through the view.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "../skills/semantic-layer/scripts/lib/validate-rules/index.ts";
import { tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const PLUGIN = join(REPO, "skills", "semantic-layer");
const VALID = join(import.meta.dir, "fixtures", "valid");

// A rule module that imports a helper from lib/validate.ts at module load, reads the view and its
// lookups, logs each call to the file PROBE_LOG names, and warns once.
function probe(name: string): string {
  return `import { appendFileSync } from "node:fs";
import { unconfirmedGoldenMessage } from "../validate.ts";
import type { RuleContext } from "./index.ts";

const helper = typeof unconfirmedGoldenMessage === "function";

export default function (ctx: RuleContext): void {
  appendFileSync(process.env.PROBE_LOG!, "${name}\\n");
  const models = [...ctx.models.values()].reduce((n, m) => n + m.size, 0);
  const sources = [...ctx.sources.keys()].sort().join(",");
  const first = [...ctx.sources.keys()].sort()[0]!;
  const fold = ctx.identRules(first).fold;
  const table = ctx.snapshotTable("warehouse", "fct_orders").table?.name;
  const paths = ctx.joinPaths("warehouse", "orders", "customers").map((p) => p.join(">")).join(";");
  ctx.warn("semantic.yaml", "${name}", \`probe ${name}: \${models} models, sources \${sources}, fold \${fold}, helper \${helper}, goldens \${ctx.goldens.length}, table \${table}, paths \${paths}, \${ctx.error.name}, \${ctx.warn.name}\`, "intake.schemas_empty");
}
`;
}

// A copy of the plugin beside the repository's packages, with no rule module but the ones a test
// writes, so the real directory and the rule files later work adds to it are left out.
function pluginCopy(): { rules: string; root: string; run: (args: string[], env?: Record<string, string>) => { code: number; stdout: string; stderr: string } } {
  const dir = tempDir();
  const plugin = join(dir, "skills", "semantic-layer");
  cpSync(PLUGIN, plugin, { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  const rules = join(plugin, "scripts", "lib", "validate-rules");
  for (const file of readdirSync(rules)) if (file !== "index.ts") rmSync(join(rules, file), { recursive: true });
  const root = join(dir, "semantic");
  cpSync(VALID, root, { recursive: true });
  const run = (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync([process.execPath, join(plugin, "scripts", "semlayer.ts"), ...args, "--root", root], {
      cwd: root,
      env: { ...process.env, SEMLAYER_NOW: "2026-01-15T12:00:00.000Z", ...env },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };
  return { rules, root, run };
}

describe("validate-rules seam", () => {
  test("a rule file dropped into the directory is found, called once per validation, and its issue appears after the others", () => {
    const { rules, root, run } = pluginCopy();
    const before = run(["validate", "--json"]);
    expect(before.stderr).toBe("");
    const expected = JSON.parse(before.stdout) as { warnings: number; issues: unknown[] };

    writeFileSync(join(rules, "zz-probe.ts"), probe("zz"));
    writeFileSync(join(rules, "aa-probe.ts"), probe("aa"));
    const log = join(root, "..", "probe.log");
    const after = run(["validate", "--json"], { PROBE_LOG: log });
    expect(after.stderr).toBe("");
    const out = JSON.parse(after.stdout) as { warnings: number; issues: unknown[] };
    expect(readFileSync(log, "utf8")).toBe("aa\nzz\n");
    // The reporting calls are the Validator's own methods, bound, so every argument reaches them.
    const probes = ["aa", "zz"].map((name) => ({
      level: "warning",
      file: "semantic.yaml",
      path: name,
      message: `probe ${name}: 3 models, sources lake,warehouse, fold none, helper true, goldens 3, table fct_orders, paths orders.customer, bound error, bound warn`,
      code: "intake.schemas_empty",
    }));
    expect(out.issues).toEqual([...expected.issues, ...probes]);
    expect(out.warnings).toBe(expected.warnings + 2);
    expect(after.code).toBe(before.code);
  });

  test("an error a rule reports fails validation, in --json and in the plain output", () => {
    const { rules, run } = pluginCopy();
    writeFileSync(
      join(rules, "refuse.ts"),
      `import type { RuleContext } from "./index.ts";\nexport default (ctx: RuleContext) => ctx.error("semantic.yaml", "probe", "probe refuses; fix it, then run semlayer validate", "schema.other");\n`,
    );
    const json = run(["validate", "--json"]);
    expect(json.code).toBe(1);
    const out = JSON.parse(json.stdout) as { ok: boolean; issues: unknown[] };
    expect(out.ok).toBe(false);
    expect(out.issues.at(-1)).toEqual({ level: "error", file: "semantic.yaml", path: "probe", message: "probe refuses; fix it, then run semlayer validate", code: "schema.other" });
    const plain = run(["validate"]);
    expect(plain.code).toBe(1);
    expect(plain.stdout + plain.stderr).toContain("probe refuses");
  });

  test("loads only rule modules, in sorted order, and stops on a module without a default function", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), "export default function () { throw new Error('index is not a rule'); }\n");
    writeFileSync(join(dir, "b.ts"), "export default function () {}\n");
    writeFileSync(join(dir, "a.ts"), "export default function () {}\n");
    writeFileSync(join(dir, "a.test.ts"), "throw new Error('a test file is not a rule');\n");
    writeFileSync(join(dir, "notes.md"), "not a module\n");
    expect(loadRules(dir).map((r) => r.file)).toEqual(["a.ts", "b.ts"]);

    writeFileSync(join(dir, "c.ts"), "export const rule = () => {};\n");
    expect(() => loadRules(dir)).toThrow(`${join(dir, "c.ts")} has no default export function`);
  });
});
