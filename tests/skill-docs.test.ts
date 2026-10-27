import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import { conditionAttributes, parseCondition } from "../skills/semantic-layer/scripts/lib/conditions.ts";
import { schemaIssues } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";

// The skill's procedure docs: every `sl` command they show must exist with the flags it uses,
// and the procedure rules the skill depends on must stay written down.

const SKILL_DIR = join(import.meta.dir, "..", "skills", "semantic-layer");
const DOCS = [
  "SKILL.md",
  "references/intake.md",
  "references/scoping.md",
  "references/interview-guide.md",
  "references/joins.md",
  "references/access.md",
  "references/verification.md",
];
const GLOBAL_FLAGS = new Set(["root", "json", "help"]);
const GOLDENS_SUBCOMMANDS = new Set(["run", "confirm", "check"]);

function read(doc: string): string {
  return readFileSync(join(SKILL_DIR, doc), "utf8");
}

interface Invocation {
  doc: string;
  line: number;
  text: string;
}

// Every `sl <command> ...` in a doc: lines of fenced code blocks and inline code spans.
function invocations(doc: string, text: string): Invocation[] {
  const out: Invocation[] = [];
  let fenced = false;
  let continued = "";
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      continued = "";
      return;
    }
    if (fenced) {
      // A trailing backslash continues a shell command on the next line.
      const joined = continued + raw.trim();
      if (joined.endsWith("\\")) {
        continued = `${joined.slice(0, -1).trimEnd()} `;
        return;
      }
      continued = "";
      const m = /(?:^|\s)(sl \S.*)$/.exec(joined);
      if (m && /^sl [a-z]/.test(m[1]!)) out.push({ doc, line, text: m[1]! });
      return;
    }
    for (const span of raw.matchAll(/`(sl [a-z][^`]*)`/g)) out.push({ doc, line, text: span[1]! });
  });
  return out;
}

function flagsOf(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map((m) => m[1]!);
}

async function problems(list: Invocation[]): Promise<string[]> {
  const out: string[] = [];
  for (const inv of list) {
    const name = inv.text.split(/\s+/)[1]!;
    const load = COMMANDS[name];
    if (!load) {
      out.push(`${inv.doc}:${inv.line} unknown command "${name}" in \`${inv.text}\``);
      continue;
    }
    const spec = (await load()).default;
    if (name === "goldens") {
      const sub = inv.text.split(/\s+/)[2];
      if (!sub || !GOLDENS_SUBCOMMANDS.has(sub)) out.push(`${inv.doc}:${inv.line} goldens needs run, confirm or check: \`${inv.text}\``);
    }
    for (const flag of flagsOf(inv.text)) {
      if (!GLOBAL_FLAGS.has(flag) && !(flag in spec.options)) out.push(`${inv.doc}:${inv.line} sl ${name} has no --${flag}: \`${inv.text}\``);
    }
  }
  return out;
}

const all = DOCS.flatMap((d) => invocations(d, read(d)));

describe("sl commands in the skill docs", () => {
  test("the docs show commands", () => {
    expect(all.length).toBeGreaterThan(40);
  });

  test("every command exists and every flag is one it takes", async () => {
    expect(await problems(all)).toEqual([]);
  });

  test("an unknown command, flag or goldens subcommand is reported", async () => {
    const bad = invocations("x.md", "`sl tables --source w --bogus` `sl frobnicate` `sl goldens --name g`");
    expect(await problems(bad)).toEqual([
      "x.md:1 sl tables has no --bogus: `sl tables --source w --bogus`",
      'x.md:1 unknown command "frobnicate" in `sl frobnicate`',
      "x.md:1 goldens needs run, confirm or check: `sl goldens --name g`",
    ]);
  });

  test("invocations parse continued lines and inline spans", () => {
    const text = [
      "Run `sl scope --source w --exclude t --write` then:",
      "```",
      "sl add-source --name lake --dialect duckdb \\",
      "  --view \"a=read_parquet('x')\"",
      "```",
    ].join("\n");
    expect(invocations("x.md", text).map((i) => i.text)).toEqual([
      "sl scope --source w --exclude t --write",
      "sl add-source --name lake --dialect duckdb --view \"a=read_parquet('x')\"",
    ]);
  });
});

describe("SKILL.md", () => {
  const skill = read("SKILL.md");

  test("stays under about 230 lines", () => {
    expect(skill.split("\n").length).toBeLessThanOrEqual(230);
  });

  test("every reference it names exists", () => {
    const named = [...skill.matchAll(/references\/([a-z-]+\.md)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    for (const f of named) expect(existsSync(join(SKILL_DIR, "references", f))).toBe(true);
  });

  test("starts the files in the first turn, before scoping questions", () => {
    expect(skill).toContain("propose a default project name");
    expect(skill).toMatch(/run `sl init --name <default>`, then `sl add-source` and `sl introspect`/);
  });
});

// The fenced code blocks of a doc, with the language after the opening fence.
function fences(text: string): { lang: string; body: string }[] {
  const out: { lang: string; body: string }[] = [];
  let open: { lang: string; lines: string[] } | null = null;
  for (const raw of text.split("\n")) {
    const t = raw.trimStart();
    if (t.startsWith("```")) {
      if (open) {
        out.push({ lang: open.lang, body: open.lines.join("\n") });
        open = null;
      } else open = { lang: t.slice(3).trim(), lines: [] };
    } else if (open) open.lines.push(raw);
  }
  return out;
}

// Rows of the spec's CLI table: command name -> every flag its rows name.
function specCli(): Map<string, Set<string>> {
  const spec = read("references/spec.md");
  const table = spec.slice(spec.indexOf("## CLI"));
  const out = new Map<string, Set<string>>();
  for (const line of table.split("\n")) {
    const m = /^\| `([a-z][a-z-]*)/.exec(line);
    if (!m) continue;
    const usage = line.split(" | ")[0]!;
    const flags = out.get(m[1]!) ?? new Set<string>();
    for (const f of usage.matchAll(/--([a-z][a-z-]*)/g)) flags.add(f[1]!);
    out.set(m[1]!, flags);
  }
  return out;
}

// Commands that read a database take --emit-sql and --results (spec: CLI).
const DB_COMMANDS = new Set(["introspect", "profile", "check-join", "goldens"]);

describe("the docs agree with the spec's CLI table", () => {
  const cli = specCli();

  test("the table lists the commands", () => {
    expect(cli.size).toBeGreaterThan(12);
    expect(cli.get("access")).toBeDefined();
    expect(cli.get("draft")?.has("new-columns")).toBe(true);
  });

  test("every command a doc shows is in the table, with every flag it uses", () => {
    const out: string[] = [];
    for (const inv of all) {
      const name = inv.text.split(/\s+/)[1]!;
      const flags = cli.get(name);
      if (!flags) {
        out.push(`${inv.doc}:${inv.line} ${name} is not in the spec's CLI table`);
        continue;
      }
      for (const flag of flagsOf(inv.text)) {
        const db = DB_COMMANDS.has(name) && (flag === "emit-sql" || flag === "results");
        if (!GLOBAL_FLAGS.has(flag) && !db && !flags.has(flag)) out.push(`${inv.doc}:${inv.line} the spec's ${name} row has no --${flag}`);
      }
    }
    expect(out).toEqual([]);
  });

  test("every --user value a doc passes to sl access is a JSON object", () => {
    const users = all.filter((i) => /^sl access\b/.test(i.text)).flatMap((i) => [...i.text.matchAll(/--user '([^']*)'/g)].map((m) => m[1]!));
    expect(users.length).toBeGreaterThan(1);
    for (const u of users) {
      if (u.startsWith("<")) continue;
      const v = JSON.parse(u);
      expect(typeof v === "object" && v !== null && !Array.isArray(v)).toBe(true);
    }
  });
});

describe("access.md examples", () => {
  const text = read("references/access.md");
  const yamlBlocks = fences(text).filter((f) => f.lang === "yaml");
  const files = yamlBlocks.filter((b) => /^status: draft$/m.test(b.body));

  test("hold a whole access.yaml in open mode", () => {
    expect(files.length).toBe(1);
    expect((parseYamlText(files[0]!.body) as { mode?: string }).mode).toBe("open");
  });

  test("the whole access.yaml matches the schema and its own names", () => {
    for (const block of files) {
      const a = parseYamlText(block.body) as {
        mode?: string;
        user_attributes?: { name: string }[];
        roles?: { name: string; assign_when?: string; allow?: { models?: string[]; tags?: string[] }; row_filters?: Record<string, unknown>[] }[];
        restrictions?: { allow: { roles?: string[]; when?: string } }[];
      };
      expect(schemaIssues("access", a, "access.md")).toEqual([]);
      const attrs = new Set((a.user_attributes ?? []).map((u) => u.name));
      const roles = new Set((a.roles ?? []).map((r) => r.name));
      const read = (src: string) => {
        for (const name of conditionAttributes(parseCondition(src))) expect(attrs.has(name)).toBe(true);
      };
      for (const r of a.roles ?? []) {
        if (r.assign_when) read(r.assign_when);
        if (a.mode !== "closed") expect(r.allow?.models).toBeUndefined();
        for (const tag of r.allow?.tags ?? []) expect(["pii", "sensitive"]).toContain(tag);
        for (const rf of r.row_filters ?? []) {
          if (typeof rf.expr === "string") for (const m of rf.expr.matchAll(/\{\{\s*user\.([a-z_]+)\s*\}\}/g)) expect(attrs.has(m[1]!)).toBe(true);
          const h = rf.hierarchy as { user?: string } | undefined;
          if (h) expect(attrs.has(String(h.user).replace(/^user\./, ""))).toBe(true);
        }
      }
      for (const x of a.restrictions ?? []) {
        expect(x.allow.roles?.length || x.allow.when).toBeTruthy();
        for (const r of x.allow.roles ?? []) expect(roles.has(r)).toBe(true);
        if (x.allow.when) read(x.allow.when);
      }
    }
  });

  test("every condition in a YAML snippet parses", () => {
    const conds = yamlBlocks.flatMap((b) => [...b.body.matchAll(/^\s*(?:assign_when|when): (.+)$/gm)].map((m) => m[1]!.trim()));
    expect(conds.length).toBeGreaterThan(4);
    for (const c of conds) expect(() => parseCondition(c.replace(/^"(.*)"$/, "$1"))).not.toThrow();
  });

  test("every condition shown inline parses", () => {
    const section = text.slice(text.indexOf("### Conditions"), text.indexOf("### The default role"));
    const spans = [...section.matchAll(/`(user\.[a-z_]+ [^`]+)`/g)].map((m) => m[1]!);
    expect(spans.length).toBeGreaterThan(5);
    for (const c of spans) expect(() => parseCondition(c)).not.toThrow();
  });

  test("the reasons table covers every reason the evaluator gives", () => {
    const evaluator = readFileSync(join(SKILL_DIR, "scripts", "lib", "access.ts"), "utf8");
    for (const reason of ["draft", "protected_tag:", "denied:", "restricted:", "not_allowed", "measure_hidden:"]) {
      expect(evaluator.includes(`"${reason}`) || evaluator.includes(`\`${reason}`)).toBe(true);
      expect(text).toMatch(new RegExp(`\\| \`${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z_.]*\` \\|`));
    }
  });
});

describe("open access and schema changes", () => {
  test("SKILL.md names every next_step phase", () => {
    const status = readFileSync(join(SKILL_DIR, "scripts", "lib", "status.ts"), "utf8");
    const union = /export type Phase =([^;]+);/.exec(status)![1]!;
    const phases = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(phases).toContain("drift");
    const skill = read("SKILL.md");
    for (const p of phases) expect(skill).toMatch(new RegExp(`\\b${p}\\b`));
  });

  test("no doc keeps the one-role, allowlist-only access model", () => {
    for (const d of DOCS) {
      const text = read(d).replace(/\s+/g, " ");
      expect(text).not.toMatch(/holds exactly one role|fails closed: a role sees only|allow lists that fail closed/);
      expect(text).not.toContain("`deny.tags: [pii]`");
    }
  });
});

// One phrase per procedure rule, so a rewrite that drops a rule fails here.
const RULES: [doc: string, rule: string, phrase: string | RegExp][] = [
  ["SKILL.md", "batch per round trip", "up to about 8"],
  ["SKILL.md", "sign-offs end with Approve?", 'ends with "Approve?"'],
  ["SKILL.md", "business-rule suggestions are guesses", "Never invite the owner to accept business-rule suggestions wholesale"],
  ["SKILL.md", "a cross-source metric is two measures", "do not write a metric"],
  ["SKILL.md", "deferral leaves scope", "sl scope --source <s> --exclude <table> --write"],
  ["SKILL.md", "dimensions through joins date a cross-model metric", "expr: order.created_at"],
  ["intake.md", "lake discovery with glob", "select file from glob("],
  ["intake.md", "changing views later", "rerun `sl introspect --source <source>`"],
  ["intake.md", "views have no row count until profile", "sl profile measures them."],
  ["intake.md", "time zones", "session time zone UTC"],
  ["scoping.md", "the combined suggested scope", "suggested_scope"],
  ["scoping.md", "unknown group row counts", "30,551+"],
  ["scoping.md", "tables can be added later, always", "Every first scoping message says that tables can be added later"],
  ["scoping.md", "exact names do not pick up new tables", "exact names do not pick up new tables"],
  ["scoping.md", "deferring a table", "## Deferring a table"],
  ["interview-guide.md", "the join reference worked example", "coalesce(customer.is_test_account, false) = false"],
  ["interview-guide.md", "join references are at most two hops", "At most two hops: `<join>.<column>` or `<join>.<join>.<column>`"],
  ["interview-guide.md", "the two-hop refunds example", "coalesce(order.customer.is_test_account, false) = false"],
  ["interview-guide.md", "the time zone question for every time dimension", "Ask for every time dimension"],
  ["interview-guide.md", "examples are illustrative", "is illustrative"],
  ["interview-guide.md", "a factual check is not an approval", "is a question, not an approval"],
  ["interview-guide.md", "caveats in the item's description", "goes into that item's own `description`"],
  ["interview-guide.md", "draft goldens early", "Leave `role` and `user` out"],
  ["joins.md", "inferred covers matching values", "or from matching values"],
  ["joins.md", "YAML relationship wording", "YAML says many_to_one, data says many_to_one"],
  ["access.md", "default role asked open", "Ask it open"],
  ["access.md", "row filters on joined models go in ON", "goes in that join's `on` clause"],
  ["access.md", "deny.fields names dimensions and measures only", "`deny.fields` names dimensions and measures only"],
  ["access.md", "access open questions", "`open_questions`, at the top level and on each role"],
  ["access.md", "aggregates only approximation", "There is no aggregates-only grant"],
  ["access.md", "whole-file readback after changes", "the whole-file readback comes again"],
  ["access.md", "open questions do not block approval", "Approval may stand with open questions"],
  ["access.md", "a related-model row filter keeps base rows on a left join", "keeps every row of the base model; it drops base rows only on an inner join"],
  ["access.md", "totals only denies the key's dimension, not a column", "deny the dimension that exposes the primary key"],
  ["access.md", "template values are guesses, the readback is the gate", "the per-role readback that follows is the gate"],
  ["SKILL.md", "joins a join reference uses are checked first", "Check and read back any join a join reference uses (Phase 6) before reading back that measure or dimension"],
  ["SKILL.md", "deferral names the table as sl tables prints it", "naming the table as `sl tables` prints it"],
  ["scoping.md", "deferral names the physical table", "Name the table as `sl tables` prints it, not the model name"],
  ["interview-guide.md", "joined dimensions share the time zone conversion", "Give the joined dimension the same conversion as the original"],
  ["verification.md", "goldens at any phase", "Draft goldens may be written at any phase"],
  ["verification.md", "explicit tolerance", "--tolerance 0"],
  ["verification.md", "--force only lifts the row limit", "`--force` lifts that limit and does nothing else"],
  ["verification.md", "request fields through to-one joins", "at most two hops"],
  ["verification.md", "confirm after measures are approved", "Confirm a golden only after the measures"],
  // Readbacks, figures and owner time.
  ["SKILL.md", "readbacks split definition from measured facts", "the definition to approve, then the measured facts"],
  ["interview-guide.md", "measured facts need no confirmation", "measured from the data, no need to confirm"],
  ["interview-guide.md", "a hedge on a measured fact keeps the approval", "does not void a yes to the definition"],
  ["interview-guide.md", "a hedged measured fact is recorded", "measured, not checked against a report"],
  ["interview-guide.md", "hand-computed figures are labelled", "computed by hand with a rule the layer cannot yet express, label it so and put the layer's own figure beside it"],
  ["interview-guide.md", "blockers are missing columns or views", "Describe a blocker as the column or view that is missing, never as a limit of the tool"],
  ["interview-guide.md", "an agreed rule is asked of the other measures", "ask in the same round trip whether it applies to every other measure of the model"],
  ["SKILL.md", "an agreed rule is asked of the other measures", "ask in the same round trip whether it applies to the model's other measures"],
  ["interview-guide.md", "time dimensions get the date's business name", "Rename each to the business name of that date (`order_date`)"],
  ["SKILL.md", "brevity before the numbered items", "after at most three lines of status"],
  ["interview-guide.md", "brevity before the numbered items", "at most three lines of status before the numbered items"],
  ["SKILL.md", "stop or continue after each batch", "Stop here or continue?"],
  ["interview-guide.md", "stop or continue after each batch", "Stop here or continue?"],
  ["SKILL.md", "owner priorities override next_batch", "Owner priorities override it"],
  ["SKILL.md", "status for the source the owner put first", "`sl status --source <s> --json` for the source the owner put first"],
  ["interview-guide.md", "owner priorities override next_batch", "Owner priorities override `next_batch`"],
  // Draft guesses and units.
  ["interview-guide.md", "exact cents on duckdb", "`<col> * 0.01` on duckdb"],
  ["interview-guide.md", "exact cents on bigquery", "`cast(<col> as numeric) / 100` on bigquery"],
  ["SKILL.md", "exact cents on duckdb", "`<col> * 0.01` on duckdb"],
  ["interview-guide.md", "additive counts draft as sums", "drafted as `sum` with `format: integer`"],
  ["interview-guide.md", "the avg fallback asks total or average", "whether people total or average it"],
  ["interview-guide.md", "dimensions and measures are required", "write `[]` when a model has none"],
  ["interview-guide.md", "join references read columns, not dimensions", "reads a physical column of the target's table, not the target model's dimension of the same name"],
  ["interview-guide.md", "aggregate rules need a view and an open question", "record an open question with the exact definition and any figure the owner gave"],
  ["interview-guide.md", "removing a measure removes what uses it", "Removing a measure also removes the draft metrics and goldens that use it"],
  // Definition joins and access.
  ["interview-guide.md", "definition joins ignore row filters", "joins it without the target's row filters"],
  ["interview-guide.md", "no helper model for row filters", "No helper model is needed"],
  ["SKILL.md", "definition joins apply whatever the role", "it applies whatever the role may see, without row filters"],
  ["access.md", "definition joins section", "### Definition joins"],
  ["access.md", "definition joins apply whatever the role may see", "The compiler applies it whenever the field is used, whatever the role may see, and joins it without the target's row filters"],
  ["access.md", "no helper model for row filters", "No helper model over the same table is needed"],
  ["access.md", "validate warns on dimensions through hidden models", "`sl validate` warns when a role is allowed a dimension whose `expr` reads through a join"],
  ["access.md", "measure filters do not warn", "A measure filter does not warn"],
  ["access.md", "a missing user attribute returns no rows", "returns no rows of that model; the compiler enforces it"],
  ["access.md", "comment-only edits need no new readback", "an edit to comments only is not one"],
  ["SKILL.md", "comment-only edits need no new readback", "a comment-only edit is not a change"],
  ["joins.md", "definition joins ignore row filters", "the compiler joins it without the target's row filters"],
  ["joins.md", "joins are named after their target's role", "Name a join after the role its target plays"],
  ["joins.md", "renaming keeps evidence", "Renaming a join keeps its evidence"],
  ["joins.md", "stale evidence warns", "differ from the join's current `keys` or `to`"],
  // Status, verification and handoff.
  ["SKILL.md", "next_step.after_owner_yes", "`next_step.after_owner_yes` is true whenever the command is an `sl approve` or `sl goldens confirm`"],
  ["SKILL.md", "the plain-output wait line", "Only after the owner says yes to its readback: <command>"],
  ["SKILL.md", "handoff names roles without goldens", "naming each role in `roles_without_goldens`"],
  ["SKILL.md", "coverage checklist at handoff", "Coverage is a checklist checked at handoff"],
  ["SKILL.md", "golden requests list metrics in measures", "there is no `metrics` key"],
  ["SKILL.md", "removing a measure removes what uses it", "removing it also removes the draft metrics and goldens that use it"],
  ["verification.md", "coverage checklist", "### Coverage checklist, checked at handoff"],
  ["verification.md", "roles without goldens", "`roles_without_goldens` in `sl status --json`"],
  ["verification.md", "a golden pins definition joins for a restricted role", "definition joins apply whatever the role may see is pinned"],
  ["verification.md", "golden requests list metrics in measures", "there is no `metrics` key"],
  ["verification.md", "draft goldens may name unknown fields", "`sl validate` warns rather than errors"],
  ["verification.md", "golden SQL adds nothing", "no `round()` around a measure"],
  ["verification.md", "definition joins in golden SQL", "write two joins"],
  ["verification.md", "re-check after a revoke", "the recorded rows stand and no new confirm is needed"],
  ["verification.md", "goldens check needs every source", "Without `--source` it checks every source"],
  // Sources and scope.
  ["SKILL.md", "cross-source formulas are recorded", "even when the owner keeps the metric in their own reports"],
  ["SKILL.md", "cross-source rules route", "federating source"],
  ["intake.md", "one view per dataset, noise included", "Make one view per dataset, including the ones that look like noise"],
  ["intake.md", "duckdb views live in main", "live in schema `main`"],
  ["intake.md", "validate catches credentials in duckdb connections", "naming the key and never the value"],
  ["intake.md", "postgres has no in-layer views", "A Postgres or warehouse source has no such place"],
  ["scoping.md", "duckdb views live in main", "are in schema `main`"],
  ["scoping.md", "re-preview unless the exact list was stated", "skip the new preview only when the owner stated the exact final list"],
  ["scoping.md", "tables --groups lists tables first", "It first lists the in-scope tables, then the groups"],
  // Review fixes.
  ["interview-guide.md", "two-hop nulls only when both hops are left", "When both hops are `left`, a refund whose order or customer is missing reads null at the end"],
  ["interview-guide.md", "an inner hop drops rows", "An `inner` hop drops such refunds instead, and an `inner` second hop also drops refunds whose order is missing"],
  ["interview-guide.md", "the column-not-dimension warning stays", "The warning stays while the filter names that column"],
  ["interview-guide.md", "a hedge on a measured fact goes in the description", "a hedge on a measured fact goes in the description"],
  ["access.md", "row-filtered targets of a dimension do not warn", "the definition join carries no row filter; `sl validate` does not warn"],
  ["SKILL.md", "row-filtered targets of a dimension do not warn", "A dimension that reads a model the role row-filters shows every row's value and validate does not warn"],
  ["SKILL.md", "coverage includes metrics and owner figures", "every approved measure and metric in at least one approved golden"],
  ["SKILL.md", "federating source is the route if modelled", "do not model it in either source. If the owner wants it modelled"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["SKILL.md", "synonyms are read back", "Read back every synonym you will write, and write none the owner did not hear in a readback"],
  ["interview-guide.md", "synonyms are read back", "write none the owner did not hear in a readback"],
  ["SKILL.md", "engineering only when no construct expresses the rule", "Ask engineering for a column or view only when no supported construct (a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source) can express the rule"],
  ["SKILL.md", "otherwise wait for the tool", "wait for the tool and say so"],
  ["interview-guide.md", "engineering only when no construct expresses the rule", "Ask engineering for a column or view only when no supported construct"],
  ["interview-guide.md", "otherwise wait for the tool", "keep the rule, wait for the tool, and say so"],
  ["intake.md", "engineering only when no construct expresses the rule", "Ask engineering for one only when no supported construct (a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source) can express the rule"],
  ["interview-guide.md", "a written-out rule skips the column warning", "writes the dimension's whole rule out and `sl validate` skips the warning"],
  ["interview-guide.md", "duckdb literal division warns", "`sl validate` warns on a duckdb measure `expr` that divides by a numeric literal"],
  ["SKILL.md", "a golden may pin a rule", "A golden may pin a rule rather than a figure"],
  ["SKILL.md", "rule goldens request the trusted grain", "confirm its measured rows only when its `reference` says which rows were checked against a report; otherwise request only the trusted grain"],
  ["verification.md", "a golden may pin a rule", "### A golden that pins a rule"],
  ["verification.md", "rule goldens request the trusted grain", "Otherwise request only the trusted grain"],
  ["verification.md", "round in golden SQL warns", "`sl validate` warns on `round(` in a golden's `sql`"],
  ["verification.md", "approved golden with a draft field is rechecked", "approve the field after its readback, then run `sl goldens check --name <g>`: if it passes, the recorded rows stand; only rows that changed need a new confirm"],
  ["SKILL.md", "approved golden with a draft field is rechecked", "then run `sl goldens check --name <g>`: if it passes, the recorded rows stand, and only changed rows need a new confirm"],
  ["verification.md", "roles without goldens hold verify", "keeps `next_step` at `verify` until a golden that runs as that role is written and confirmed"],
  ["verification.md", "done does not tick the checklist", "it does not tick this list"],
  ["access.md", "open-question edits need no re-approval", "neither is deleting an answered open question or adding a new one"],
  ["access.md", "open-question edits are mentioned", "Mention such an open-question edit in your next message"],
  ["SKILL.md", "open-question edits need no re-approval", "neither is deleting an answered open question or adding one, which you mention in the next message"],
  ["SKILL.md", "a cross-source side that cannot exist yet", "record the formula on the measure that exists and an open question on the other model naming the missing column or view"],
  ["SKILL.md", "unstated formulas are open questions", "A formula the owner never stated is an open question, not a description"],
  ["interview-guide.md", "unstated formulas are open questions", "A formula the owner never stated is an open question, not a description"],
  ["SKILL.md", "handoff lists validate warnings", "every warning `sl validate` still prints, with the reason it stands"],
  ["SKILL.md", "handoff lists draft metrics and goldens", "every draft metric (`draft_metrics` in status), draft golden (`draft_goldens`) and draft field (`draft_fields`)"],
  ["SKILL.md", "done means the measurable phases", "`next_step` reaches `done` when the phases the CLI can measure are complete"],
  ["SKILL.md", "tick the checklist before the handoff", "Tick that checklist in `references/verification.md`"],
  ["SKILL.md", "validate first on resume", "run `sl validate` first and fix every new warning"],
  ["SKILL.md", "new warnings surface new rules", "new warnings surface rules added since the last session (such as exact cents on duckdb"],
  ["SKILL.md", "removing a drafted field", "Removing a drafted field is a hand edit of the model file; `sl validate` then names what still uses it"],
  ["interview-guide.md", "removing a drafted field", "Removing a drafted field is a hand edit of the model file"],
  ["SKILL.md", "resume news goes in the numbered items", "news from a resumed session (warnings fixed, rules added) goes into the numbered items"],
  ["interview-guide.md", "resume news goes in the numbered items", "goes into the numbered items, not the status"],
  ["SKILL.md", "every round ends with stop or continue", "End every round trip, the last one and the handoff included, with one line"],
  ["interview-guide.md", "every round ends with stop or continue", "End every round trip, the last one and the handoff included"],
  // Standing warnings, cast divisors, coverage by role, rounded ratios.
  ["SKILL.md", "a warning stands only with a recorded reason", "A warning stands only when its reason is written in the file it points at (Phase 10); fix every other one"],
  ["SKILL.md", "fixing a warning on an approved item rechecks goldens", "After fixing a warning on an approved measure or golden (a `round()` removed), run `sl goldens check`; when the rows changed, show the new figure and confirm again only on the owner's yes"],
  ["SKILL.md", "handoff writes standing reasons into files", "Write that reason into the file the warning points at, so a resumed session leaves it"],
  ["SKILL.md", "waiting for the tool is recorded", "write in the field's `description` why its warning stands"],
  ["interview-guide.md", "warnings that stand", "### Warnings that stand"],
  ["interview-guide.md", "a deliberate column read is recorded", "say in the field's `description` that it reads the column on purpose"],
  ["interview-guide.md", "a written-out rule is read back", "`sl validate` checks only that the columns are named, not the rule; read the written-out filter back against the dimension's `expr`"],
  ["interview-guide.md", "a draft golden's missing measure is recorded", "add an open question on the model that measure belongs to, naming the golden"],
  ["verification.md", "a draft golden's missing measure is recorded", "Add an open question on the model that measure belongs to, naming the golden"],
  ["interview-guide.md", "a cast divisor is still a double on duckdb", "a cast divisor such as `/ 100::decimal(18, 2)` is still a double there"],
  ["verification.md", "a cast divisor is still a double on duckdb", "a cast divisor such as `/ 100::decimal(18, 2)` included"],
  ["interview-guide.md", "same engineering list", "(a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source)"],
  ["access.md", "writing an answer into a role is a change", "Writing the answer into roles, patterns, denials or row filters is a change; only the question's own deletion or addition is not"],
  ["SKILL.md", "writing an answer into a role is a change", "writing its answer into roles, patterns, denials or row filters is a change"],
  ["SKILL.md", "every role needs a golden", "an approved golden that runs as each role in `access.yaml`, restricted or not (a golden with no `role` runs as `default_role`)"],
  ["verification.md", "every role needs a golden", "Every role in `access.yaml`, restricted or not, has at least one approved golden that runs as it"],
  ["SKILL.md", "a cross-source side with no model", "when that model does not exist yet, on the existing measure's model and among the handoff's cross-source questions"],
  ["interview-guide.md", "a cross-source side with no model", "when that model does not exist yet, on the existing measure's model and in the handoff"],
  ["SKILL.md", "rounded ratios use tolerance", "For a ratio compared with a report figure rounded to cents (AOV $134.46), show the unrounded value and agree the match; an agreed difference goes in `tolerance`"],
  ["verification.md", "rounded ratios use tolerance", "record the agreed difference in `tolerance`"],
  ["verification.md", "tolerance covers every column", "put the ratio in a golden of its own"],
  ["verification.md", "fixing a warning on an approved item rechecks goldens", "After fixing a `sl validate` warning on an approved measure or golden"],
  // Open access: exceptions first, protected tags, roles by attribute, restrictions, span of control.
  ["access.md", "access is open by default", "Access is open by default"],
  ["access.md", "draft items are never exposed", "Draft items are never exposed, in either mode"],
  ["access.md", "allow.models has no effect in open mode", "`allow.models` has no effect in open mode"],
  ["access.md", "the interview starts from exceptions", "Start from the exceptions, not from a list of roles"],
  ["access.md", "the exceptions question", "Is there anything some people should not see?"],
  ["access.md", "no exceptions is still approved", "an approved `access.yaml` with `mode: open` and no roles is a complete access phase"],
  ["access.md", "every protected tag is confirmed", "Confirm every `pii` and `sensitive` tag, and who may see each"],
  ["access.md", "protected tags hide in both modes", "`pii` and `sensitive` are protected in both modes"],
  ["access.md", "public never overrides a protected tag", "It never overrides `pii` or `sensitive` on the same field"],
  ["access.md", "the sensitivity warning", "is visible to everyone and looks sensitive (<reason>); tag it pii or sensitive, or tag it public if everyone may see it"],
  ["access.md", "roles held by condition", "when its `assign_when` condition is true for the user's attributes"],
  ["access.md", "several roles combine as a union", "an item is visible when any role they hold makes it visible"],
  ["access.md", "default role only without another role", "`default_role` applies only when the user holds no other role"],
  ["access.md", "conditions read declared attributes", "Every attribute a condition reads must be declared in `user_attributes`"],
  ["access.md", "row filters union across roles", "a role they hold with no row filter on that model contributes every row"],
  ["access.md", "no role in open mode sees every row", "In open mode a user who holds no role sees every row"],
  ["access.md", "a metric needs its measures visible", "A metric is visible only when the metric itself is visible and every measure it uses is visible"],
  ["access.md", "a hidden field is never named", "A request may never name a hidden field anywhere: selected, grouped, filtered or sorted"],
  ["access.md", "span of control section", "### Span of control"],
  ["access.md", "closure: every pair at any depth", "one row per manager and member pair at any depth"],
  ["access.md", "ask for a closure view", "When the source has only a `manager_id` column on the employees table, ask the owner's engineers for a view"],
  ["access.md", "the closure model reads without row filters", "reads the closure model without its own row filters"],
  ["access.md", "sl access explains the default audience", "With no `--user` and no `--roles` it explains the default audience"],
  ["access.md", "sl access before the whole-file readback", "Run it for the default audience first, then once per role"],
  ["access.md", "interview exceptions are written before approval", "before you run `sl approve` on the table or field"],
  ["access.md", "the open-mode table readback", "everyone will be able to see this once approved; is that right?"],
  ["SKILL.md", "the open-mode table readback", "everyone will be able to see this once approved; is that right?"],
  ["interview-guide.md", "the open-mode table readback", "Everyone will be able to see this once approved; is that right?"],
  ["interview-guide.md", "new fields of signed-off tables are read back as visible", "so does the readback of a field approved into a table already signed off"],
  ["SKILL.md", "access is open by default", "Access is open by default"],
  ["SKILL.md", "the exceptions question", "is there anything some people should not see?"],
  ["SKILL.md", "sl access in the readback", "Show the owner what people see with `sl access` (the default audience)"],
  ["SKILL.md", "row filters union across roles", "a held role with no filter on a model contributes every row"],
  ["SKILL.md", "default role asked open", "ask it open"],
  ["verification.md", "a golden for span of control", "for a span-of-control row filter, one question as a manager"],
  ["verification.md", "a golden for each restriction", "for each restriction, one question as a role or user it allows"],
  ["joins.md", "a closure model needs no join", "the filtered model needs no join to it"],
  // Keeping the layer current.
  ["SKILL.md", "keeping the layer current", "## Keeping the layer current"],
  ["SKILL.md", "rerun introspect on a schedule", "on a schedule the owner picks"],
  ["SKILL.md", "missing columns first", "**Missing columns first**"],
  ["SKILL.md", "drift comes first after intake", "The `drift` phase, an approved field reading a column the table no longer has, comes first after intake"],
  ["SKILL.md", "draft new columns", "`sl draft --source <s> --new-columns`"],
  ["SKILL.md", "deliberate omissions in ignored_columns", "goes into the model's `ignored_columns`"],
  ["SKILL.md", "draft records what it leaves out", "lists the columns it leaves out on purpose in the model's `ignored_columns`"],
  ["interview-guide.md", "keeping the layer current", "## Keeping the layer current"],
  ["interview-guide.md", "the drift readback", "the table changed; read the affected items back to the owner"],
  ["interview-guide.md", "a rename is a removal and an addition", "A rename shows as a removed column and an added one"],
  ["interview-guide.md", "interview only the new fields", "Interview only the new fields"],
  ["interview-guide.md", "new columns keep approved items", "Approved items, comments and the model's own `status` stay as they were"],
  ["interview-guide.md", "draft lists left-out columns", "`ignored_columns`: the columns it leaves out of the model on purpose"],
  ["interview-guide.md", "unwanted columns are ignored", "A column the owner does not want in the layer goes into the model's `ignored_columns`"],
  ["intake.md", "a rerun prints the changes", "A rerun prints what changed since the previous snapshot"],
  ["scoping.md", "new tables after a rerun", "A rerun of `sl introspect` lists the tables added since the last snapshot"],
  ["joins.md", "a changed key column is checked again", "including when a rerun of `sl introspect` shows a key column removed, renamed or retyped"],
  ["verification.md", "goldens check after a schema change", "after a rerun of `sl introspect` that changed a modeled table"],
  // Conditions, role unions and what draft tags.
  ["access.md", "a negated grant is true for an unknown user", "so a grant using either one is true for a user the tool knows nothing about"],
  ["access.md", "a negated grant is paired with a presence test", "Pair it with a presence test"],
  ["access.md", "closed mode does not hide from a group", "Closed mode does not help, because there too an item is visible when any held role shows it"],
  ["access.md", "only a restriction hides from a group", "only its `allow.roles` or `allow.when` see the target, whatever other roles a person holds"],
  ["access.md", "an empty role is not harmless", "A role that grants, denies and filters nothing is not harmless"],
  ["access.md", "an empty role blocks the default", "it keeps `default_role` from applying"],
  ["access.md", "an exception is checked for a reason other than draft", "hidden for a reason other than `draft`"],
  ["interview-guide.md", "an exception is checked for a reason other than draft", "hidden for a reason other than `draft`"],
  ["access.md", "tags live in the model file", "a `pii` or `sensitive` tag on the field or model in the model file"],
  ["access.md", "near-unique text is left out, not tagged", "is left out and listed in `ignored_columns`, with an open question naming the tag to add"],
  ["SKILL.md", "near-unique text is left out, not tagged", "differs on nearly every row is left out, not tagged"],
  ["interview-guide.md", "near-unique text is left out, not tagged", "which gets no tag but an open question naming the tag to add"],
  ["SKILL.md", "a retype is recorded as an open question", "changed from <from> to <to> on <date>; read back <fields>"],
  ["interview-guide.md", "a retype is recorded as an open question", "changed from <from> to <to> on <date>; read back <fields>"],
  ["interview-guide.md", "status does not list retypes", "Only the rerun's output shows a retype"],
];

describe("readbacks and examples", () => {
  const docs = ["SKILL.md", ...["access.md", "joins.md", "interview-guide.md", "verification.md"].map((d) => `references/${d}`)];

  test('sign-off readbacks end with a bare "Approve?"', () => {
    for (const d of docs) expect(read(d)).not.toMatch(/Approve (this|the) [a-z ]+\?/);
  });

  test("coverage does not ask for a golden per restricted role only", () => {
    for (const d of DOCS) expect(read(d).replace(/\s+/g, " ")).not.toMatch(/(one approved golden|one question) per restricted role|Every restricted role has/);
  });

  test("the supported-construct list is the same wherever engineering is asked", () => {
    const list = "(a join reference within two hops, a filter that writes the rule out, or a DuckDB view in `connection.views`, on a DuckDB source)";
    for (const d of ["SKILL.md", "references/interview-guide.md", "references/intake.md"]) {
      const text = read(d).replace(/\s+/g, " ");
      for (const m of text.matchAll(/no supported construct (\([^)]*\))/g)) expect(m[1]).toBe(list);
      expect(text).toContain(list);
    }
  });

  test("join references are not limited to one hop", () => {
    for (const d of DOCS) expect(read(d)).not.toMatch(/one hop only|only one hop/i);
  });

  test("example joins are named after their target's role, not a column", () => {
    for (const d of DOCS) expect(read(d)).not.toContain("`orders.region`");
  });

  test("examples do not use the fixture's test-account email rule", () => {
    for (const d of docs) expect(read(d)).not.toMatch(/-test\.com/);
  });
});

describe("claims the code contradicts", () => {
  test("no doc says a condition-based grant always fails closed", () => {
    for (const d of DOCS) expect(read(d).replace(/\s+/g, " ")).not.toContain("so a grant fails closed");
  });

  test("no doc calls a role that grants nothing harmless", () => {
    for (const d of DOCS) expect(read(d).replace(/\s+/g, " ")).not.toMatch(/changes nothing; leave it out/);
  });

  test("no doc offers closed mode as a way to hide an item from a group", () => {
    for (const d of DOCS) expect(read(d).replace(/\s+/g, " ")).not.toMatch(/a protected tag, or `mode: closed`/);
  });

  test("no doc says draft tags near-unique text", () => {
    for (const d of DOCS) {
      const text = read(d).replace(/\s+/g, " ");
      expect(text).not.toMatch(/near-unique strings that are not keys\) `sensitive`/);
      expect(text).not.toMatch(/or by profile \(a text column/);
      expect(text).not.toContain("tags what looks sensitive by name or profile");
    }
  });
});

describe("skill frontmatter", () => {
  test("the description is at most 1024 characters", () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(read("SKILL.md"));
    expect(m).not.toBeNull();
    const front = parseYamlText(m![1]!) as { description?: unknown };
    expect(typeof front.description).toBe("string");
    expect((front.description as string).length).toBeGreaterThan(0);
    expect((front.description as string).length).toBeLessThanOrEqual(1024);
  });
});

describe("procedure rules in the docs", () => {
  for (const [doc, rule, phrase] of RULES) {
    const path = doc === "SKILL.md" ? doc : `references/${doc}`;
    test(`${doc}: ${rule}`, () => {
      const text = read(path).replace(/\s+/g, " ");
      if (typeof phrase === "string") expect(text).toContain(phrase.replace(/\s+/g, " "));
      else expect(text).toMatch(phrase);
    });
  }
});
