import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";

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

  test("stays under about 220 lines", () => {
    expect(skill.split("\n").length).toBeLessThanOrEqual(220);
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
