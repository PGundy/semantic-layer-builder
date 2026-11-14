import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metricEntries, accessEntry, modelEntries } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { writeYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { Model } from "../skills/semantic-layer/scripts/lib/types.ts";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { shellWrites } from "../skills/semantic-layer/scripts/hooks/shell-writes.ts";
import { tempDir } from "./helpers.ts";

// The plugin's PreToolUse hook (spec: Hand edits): hook payloads for each tool, against a synthetic
// semantic root whose approved items carry real content hashes.

const REPO = join(import.meta.dir, "..");
let dir: string;
let root: string;
let outside: string;

function approved<T extends object>(item: T): T {
  return { ...item, status: "approved", approved_by: "Test Owner", approved_at: "2026-01-15" };
}

// Writes the models of source wh with approved_hash stamped on every approved item.
function writeModels(models: Record<string, Record<string, unknown>>): void {
  const lookup = (n: string) => models[n] as unknown as Model | undefined;
  for (const [name, m] of Object.entries(models)) {
    for (const e of modelEntries("wh", { ...(m as unknown as Model), model: name }, lookup, "duckdb")) {
      const target = e.kind === "model" ? m : e.item;
      if (target.status === "approved") target.approved_hash = e.hash;
    }
  }
  for (const [name, m] of Object.entries(models)) writeYaml(join(root, "models", "wh", `${name}.yaml`), m);
}

function build(): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "semantic.yaml"), "name: hooktest\n");
  writeYaml(join(root, "sources", "wh.yaml"), { source: "wh", dialect: "duckdb", connection: { database: "wh.duckdb" } });
  writeModels({
    orders: approved({
      model: "orders",
      table: "main.orders",
      grain: "One row per order.",
      primary_key: ["order_id"],
      dimensions: [approved({ name: "order_date", expr: "created_at", type: "time", time_grains: ["day"] })],
      measures: [
        approved({ name: "revenue", expr: "amount_cents / 100.0", agg: "sum", filter: "status = 'completed'", description: "Revenue in dollars." }),
        approved({ name: "revenue_ne", expr: "amount_cents / 100.0", agg: "sum", filter: "customer.region.code = 'NE'" }),
        { name: "order_count", expr: "order_id", agg: "count", status: "draft" },
      ],
      joins: [approved({ name: "customer", to: "customers", keys: [{ from: "customer_id", to: "customer_id" }], relationship: "many_to_one" })],
    }),
    customers: {
      model: "customers",
      table: "main.customers",
      grain: "One row per customer.",
      primary_key: ["customer_id"],
      status: "draft",
      dimensions: [{ name: "email", expr: "email", type: "string", status: "draft" }],
      joins: [{ name: "region", to: "regions", keys: [{ from: "region_id", to: "region_id" }], relationship: "many_to_one", status: "draft" }],
    },
    regions: { model: "regions", table: "main.regions", primary_key: ["region_id"], status: "draft", dimensions: [{ name: "code", expr: "code", type: "string", status: "draft" }] },
  });
  const metrics: Record<string, unknown>[] = [
    approved({ name: "aov", source: "wh", type: "ratio", numerator: "orders.revenue", denominator: "orders.order_count", description: "Average order value." }),
    { name: "orders_per_day", source: "wh", type: "derived", expr: "{orders.order_count}", status: "draft" },
  ];
  for (const e of metricEntries(metrics)) if (e.item.status === "approved") e.item.approved_hash = e.hash;
  writeYaml(join(root, "metrics.yaml"), { metrics });
  const access: Record<string, unknown> = approved({ mode: "open", roles: [{ name: "analyst", assign_when: "user.department == 'analytics'" }], open_questions: [] });
  access.approved_hash = accessEntry(access)!.hash;
  writeYaml(join(root, "access.yaml"), access);
  writeYaml(join(root, "goldens", "revenue_2025.yaml"), {
    name: "revenue_2025",
    question: "What was revenue in 2025?",
    request: { source: "wh", measures: ["orders.revenue"] },
    sql: "select sum(amount_cents / 100.0) as revenue from main.orders",
    reference: "Finance close.",
    status: "approved",
    expected: { tolerance: 0, rows: [{ revenue: 100.5 }] },
    confirmed_by: "Test Owner",
    confirmed_at: "2026-01-15",
  });
  writeYaml(join(root, "goldens", "orders_2025.yaml"), {
    name: "orders_2025",
    question: "How many orders in 2025?",
    request: { source: "wh", measures: ["orders.order_count"] },
    sql: "select count(*) as order_count from main.orders",
    status: "draft",
  });
  mkdirSync(join(root, ".sl", "pending"), { recursive: true });
  writeFileSync(join(root, ".sl", "ledger.jsonl"), '{"kind":"reply"}\n');
  writeFileSync(join(root, ".sl", "pending", "rb_0001.json"), "{}\n");
}

// Every file under the directory with its contents, to show the hook writes nothing.
function tree(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(d, { recursive: true }) as string[]) {
    const p = join(d, f);
    if (statSync(p).isFile()) out[f] = readFileSync(p, "utf8");
  }
  return out;
}

let before: Record<string, string>;

beforeAll(() => {
  dir = tempDir("hook");
  root = join(dir, "semantic");
  outside = join(dir, "elsewhere");
  mkdirSync(outside);
  build();
  before = tree(dir);
});

afterAll(() => {
  // The hook only reads: no call above changed any file.
  expect(tree(dir)).toEqual(before);
  rmSync(dir, { recursive: true, force: true });
});

function call(tool: string, input: Record<string, unknown>, cwd = dir): Verdict {
  return checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd }));
}

const model = (name = "orders") => join(root, "models", "wh", `${name}.yaml`);
const read = (p: string) => readFileSync(p, "utf8");

function edit(file: string, from: string, to: string, extra: Record<string, unknown> = {}): Verdict {
  expect(read(file)).toContain(from);
  return call("Edit", { file_path: file, old_string: from, new_string: to, ...extra });
}

function refused(v: Verdict, ...parts: string[]): void {
  expect(v.allow).toBe(false);
  for (const p of parts) expect(v.message).toContain(p);
}

function allowed(v: Verdict): void {
  expect(v).toEqual({ allow: true });
}

describe("approval fields", () => {
  test("approving a draft measure by hand is refused, naming sl approve", () => {
    const v = edit(model(), "agg: count\n    status: draft", "agg: count\n    status: approved\n    approved_by: Test Owner");
    refused(v, "approval fields of wh.orders.order_count", "approved_by, status", "sl readback --targets wh.orders.order_count", "sl approve --target wh.orders.order_count");
  });

  test("approving a draft metric with Write is refused", () => {
    const text = read(join(root, "metrics.yaml")).replace("expr: \"{orders.order_count}\"\n    status: draft", 'expr: "{orders.order_count}"\n    status: approved');
    refused(call("Write", { file_path: join(root, "metrics.yaml"), content: text }), "approval fields of metric:orders_per_day");
  });

  test("removing an approval field is refused", () => {
    refused(edit(model(), "    approved_by: Test Owner\n    approved_at: 2026-01-15\n    approved_hash", "    approved_at: 2026-01-15\n    approved_hash"), "approval fields of wh.orders.order_date (approved_by)");
  });

  test("making an approved item a draft by hand is refused, naming --revoke", () => {
    const v = edit(model(), "status: approved\napproved_by", "status: draft\napproved_by");
    refused(v, "approval fields of wh.orders (status)", "sl approve --target wh.orders --revoke");
  });

  test("changing a recorded approved_hash is refused", () => {
    refused(edit(model(), "approved_hash: sha256:", "approved_hash: sha256:0"), "approval fields of wh.orders");
  });

  test("a golden's confirmation fields are refused, naming sl goldens confirm", () => {
    const g = join(root, "goldens", "orders_2025.yaml");
    refused(edit(g, "status: draft", "status: approved\nconfirmed_by: Test Owner"), "confirmation fields of golden:orders_2025", "sl goldens confirm --name orders_2025");
  });

  test("access.yaml's last_approved is an approval field", () => {
    refused(edit(join(root, "access.yaml"), "mode: open", "mode: open\nlast_approved: { by: Someone, at: 2026-01-01 }"), "approval fields of access (last_approved)");
  });
});

describe("approved items", () => {
  test("editing an approved measure's expr is refused, naming the typed edits and --revoke", () => {
    const v = edit(model(), "expr: amount_cents / 100.0\n    agg: sum\n    filter: status", "expr: amount_cents\n    agg: sum\n    filter: status");
    refused(v, "wh.orders.revenue is approved", "sl set", "sl approve --target wh.orders.revenue --revoke");
  });

  test("editing an approved model's table or an approved join is refused", () => {
    refused(edit(model(), "table: main.orders", "table: main.orders_v2"), "wh.orders is approved");
    refused(edit(model(), "relationship: many_to_one", "relationship: one_to_one"), "wh.orders.customer is approved");
  });

  test("removing an approved measure is refused", () => {
    const text = read(model());
    const start = text.indexOf("  - name: revenue_ne");
    const end = text.indexOf("  - name: order_count");
    refused(call("Write", { file_path: model(), content: text.slice(0, start) + text.slice(end) }), "removes or renames approved wh.orders.revenue_ne", "sl remove-field wh.orders.revenue_ne");
  });

  test("deleting the content of a file with approved items is refused", () => {
    const v = call("Write", { file_path: model(), content: "" });
    refused(v, "removes or renames approved wh.orders. To remove it, make it a draft first with sl approve --target wh.orders --revoke --recursive");
    expect(v.message!.split("\n").length).toBe(6);
  });

  test("changing an approved model's model or source key is refused; a draft model's is not", () => {
    refused(edit(model(), "model: orders\n", "model: orders_v2\n"), "changes the model or source key of wh.orders", "sl approve --target wh.orders --revoke --recursive");
    refused(edit(model(), "model: orders\n", "model: orders\nsource: lake\n"), "model or source key of wh.orders");
    allowed(edit(model("regions"), "model: regions\n", "model: regions_v2\n"));
  });

  test("a description of an approved measure may be edited", () => {
    allowed(edit(model(), "description: Revenue in dollars.", "description: Revenue in US dollars, completed orders only."));
  });

  test("a draft measure, and a draft model, may be edited freely", () => {
    allowed(edit(model(), "expr: order_id", "expr: distinct order_id"));
    allowed(edit(model("customers"), "expr: email", "expr: lower(email)"));
    allowed(edit(model("regions"), "table: main.regions", "table: main.regions_v2"));
  });

  test("a new model file written as approved is refused", () => {
    refused(call("Write", { file_path: join(root, "models", "wh", "products.yaml"), content: "model: products\ntable: main.products\nstatus: approved\n" }), "approval fields of wh.products (status)");
  });

  test("a new draft model file may be written", () => {
    allowed(call("Write", { file_path: join(root, "models", "wh", "products.yaml"), content: "model: products\ntable: main.products\nstatus: draft\n" }));
  });

  test("a join another model's approved measure reads through is guarded", () => {
    const v = edit(model("customers"), "from: region_id", "from: home_region_id");
    refused(v, "wh.orders.revenue_ne is approved and reads through a join this edit changes", "sl approve --target wh.orders.revenue_ne --revoke");
  });

  test("restoring the content an approved_hash records is allowed", () => {
    // A copy whose approved revenue was changed after approval, then restored by hand.
    const copy = join(dir, "restore");
    cpSync(root, copy, { recursive: true });
    const f = join(copy, "models", "wh", "orders.yaml");
    writeFileSync(f, read(f).replace("expr: amount_cents / 100.0\n    agg: sum\n    filter: status", "expr: amount_cents\n    agg: sum\n    filter: status"));
    before = tree(dir);
    allowed(call("Edit", { file_path: f, old_string: "expr: amount_cents\n    agg: sum\n    filter: status", new_string: "expr: amount_cents / 100.0\n    agg: sum\n    filter: status" }));
    refused(call("Edit", { file_path: f, old_string: "expr: amount_cents\n    agg: sum\n    filter: status", new_string: "expr: amount_cents * 2\n    agg: sum\n    filter: status" }), "wh.orders.revenue is approved");
  });

  test("an approved metric's numerator is guarded, its description is not", () => {
    const m = join(root, "metrics.yaml");
    refused(edit(m, "numerator: orders.revenue", "numerator: orders.revenue_ne"), "metric:aov is approved");
    allowed(edit(m, "description: Average order value.", "description: Average order value (AOV)."));
  });

  test("an approved access.yaml is guarded, its open questions are not", () => {
    const a = join(root, "access.yaml");
    refused(edit(a, "mode: open", "mode: closed"), "access.yaml is approved", "sl approve --target access --revoke");
    allowed(edit(a, "open_questions: []", "open_questions:\n  - Who sees refunds?"));
  });

  test("a confirmed golden's expected rows are guarded; its reference and a draft golden are not", () => {
    const g = join(root, "goldens", "revenue_2025.yaml");
    refused(edit(g, "revenue: 100.5", "revenue: 101"), "golden:revenue_2025 is confirmed", "sl goldens confirm --name revenue_2025");
    refused(edit(g, "tolerance: 0", "tolerance: 0.1"), "golden:revenue_2025 is confirmed");
    allowed(edit(g, "reference: Finance close.", "reference: Finance close, 2025."));
    allowed(edit(join(root, "goldens", "orders_2025.yaml"), "count(*)", "count(distinct order_id)"));
  });
});

describe("MultiEdit, matching and paths", () => {
  test("MultiEdit is checked on the file after every edit", () => {
    const file = model();
    allowed(call("MultiEdit", { file_path: file, edits: [{ old_string: "Revenue in dollars.", new_string: "Revenue." }, { old_string: "expr: order_id", new_string: "expr: id" }] }));
    refused(
      call("MultiEdit", { file_path: file, edits: [{ old_string: "Revenue in dollars.", new_string: "Revenue." }, { old_string: "table: main.orders", new_string: "table: x" }] }),
      "wh.orders is approved",
    );
  });

  test("replace_all applies every occurrence", () => {
    refused(edit(model(), "amount_cents / 100.0", "amount_cents", { replace_all: true }), "wh.orders.revenue is approved");
  });

  test("a relative file_path resolves against the call's cwd", () => {
    refused(call("Edit", { file_path: "models/wh/orders.yaml", old_string: "table: main.orders", new_string: "table: x" }, root), "wh.orders is approved");
  });

  test("a link from outside the root to a model file is resolved", () => {
    const link = join(outside, "orders-link.yaml");
    symlinkSync(model(), link);
    before = tree(dir);
    refused(call("Edit", { file_path: link, old_string: "table: main.orders", new_string: "table: x" }), "wh.orders is approved");
  });

  test("an edit written with straight quotes matches a file with curly ones", () => {
    const copy = join(dir, "quotes");
    cpSync(root, copy, { recursive: true });
    const f = join(copy, "models", "wh", "orders.yaml");
    writeFileSync(f, read(f).replace("filter: status = 'completed'", "filter: status = ‘completed’"));
    before = tree(dir);
    refused(call("Edit", { file_path: f, old_string: "status = 'completed'", new_string: "status = 'shipped'" }), "wh.orders.revenue is approved");
  });

  test("files outside a semantic root are allowed, approval fields and all", () => {
    const f = join(outside, "model.yaml");
    allowed(call("Write", { file_path: f, content: "status: approved\napproved_by: Someone\n" }));
    allowed(call("Bash", { command: `sed -i 's/a/b/' ${f}` }));
  });

  test("files in the root outside the guarded parts are allowed", () => {
    allowed(call("Write", { file_path: join(root, "semantic.yaml"), content: "name: hooktest\ndescription: Test.\n" }));
    allowed(call("Write", { file_path: join(root, ".sl", "plans", "p1.json"), content: "{}" }));
    allowed(call("Write", { file_path: join(root, "models", "README.md"), content: "notes" }));
  });

  test("NotebookEdit on a layer file is refused, on a notebook elsewhere allowed", () => {
    refused(call("NotebookEdit", { notebook_path: model(), new_source: "x" }), "not a notebook");
    allowed(call("NotebookEdit", { notebook_path: join(outside, "n.ipynb"), new_source: "x" }));
  });
});

describe("ledger and pending readbacks", () => {
  test("writing or editing the ledger by hand is refused", () => {
    const ledger = join(root, ".sl", "ledger.jsonl");
    refused(call("Write", { file_path: ledger, content: '{"kind":"reply","verdict":"yes"}\n' }), ".sl/ledger.jsonl is written only by the CLI", "sl reply --readback");
    refused(edit(ledger, '{"kind":"reply"}', '{"kind":"reply","verdict":"yes"}'), "written only by the CLI");
  });

  test("a pending readback, existing or new, is refused", () => {
    refused(call("Edit", { file_path: join(root, ".sl", "pending", "rb_0001.json"), old_string: "{}", new_string: "{ }" }), ".sl/pending/rb_0001.json is written only by the CLI");
    refused(call("Write", { file_path: join(root, ".sl", "pending", "rb_0002.json"), content: "{}" }), "sl readback writes .sl/pending/");
  });
});

describe("Bash", () => {
  const sh = (command: string, cwd = dir) => call("Bash", { command }, cwd);

  test("sed -i on a model is refused", () => {
    refused(sh(`sed -i 's/status: draft/status: approved/' ${model()}`), "models/wh/orders.yaml", "(sed -i)", "typed edit");
    refused(sh("sed -i.bak -e 's/a/b/' models/wh/orders.yaml", root), "(sed -i)");
    refused(sh(`cd ${root} && perl -pi -e 's/a/b/' metrics.yaml`), "metrics.yaml", "(perl -i)");
  });

  test("redirections, tee, cp, mv and rm onto layer files are refused", () => {
    refused(sh(`echo '{"verdict":"yes"}' >> ${root}/.sl/ledger.jsonl`), ".sl/ledger.jsonl", "written only by the CLI");
    refused(sh(`cat x > ${root}/access.yaml`), "access.yaml", "redirection >");
    refused(sh(`echo x | tee -a ${root}/goldens/revenue_2025.yaml`), "goldens/revenue_2025.yaml", "(tee)");
    refused(sh(`cp /tmp/orders.yaml ${root}/models/wh/orders.yaml`), "(cp)");
    refused(sh(`cp /tmp/orders.yaml ${root}/models/wh/`), "models/wh", "(cp)");
    refused(sh(`mv ${model()} /tmp/`), "(mv)");
    refused(sh(`rm -rf ${root}/goldens`), "goldens", "(rm)");
    refused(sh(`rm -rf ${root}`), "the semantic root itself");
    refused(sh(`rm ${root}/models/wh/*.yaml`), "models/wh/customers.yaml");
    refused(sh(`yq -i '.status = "approved"' ${model()}`), "(yq -i)");
    refused(sh(`printf x 2>/dev/null 1> ${root}/.sl/pending/rb_9.json`), ".sl/pending/rb_9.json");
  });

  test("nested shells, heredocs and variables are read", () => {
    refused(sh(`bash -c "sed -i 's/a/b/' ${model()}"`), "(sed -i)");
    refused(sh(`cat > ${model()} <<'EOF'\nmodel: orders\nEOF`), "redirection >");
    refused(sh('echo x >> "$ROOT/.sl/ledger.jsonl"'), "may write $ROOT/.sl/ledger.jsonl");
  });

  test("sl commands and reads are allowed", () => {
    allowed(sh(`bun skills/semantic-layer/scripts/sl.ts reply --readback rb_0001 --item 1 --text "Yes > fine, approve it" --verdict yes --by "Test Owner" --root ${root}`));
    allowed(sh(`bun skills/semantic-layer/scripts/sl.ts approve --target wh.orders.order_count --root ${root} --json > /tmp/out.json 2>&1`));
    allowed(sh(`bun skills/semantic-layer/scripts/sl.ts set wh.orders.revenue expr "amount_cents / 100.0" --root ${root} | tee /tmp/log.txt`));
    allowed(sh(`cat ${model()} && grep -n approved ${root}/metrics.yaml && sed -n 1,5p ${model()}`));
    allowed(sh(`git diff -- ${root} && cp ${model()} /tmp/orders-copy.yaml`));
    allowed(sh(`cat > /tmp/notes.txt <<EOF\nwrite > ${model()} later\nEOF`));
  });

  test("shellWrites resolves against the cwd and every cd, and skips descriptor duplications", () => {
    // The sed script is read as a path too: it never names a layer file.
    expect(shellWrites("cd /a && sed -i s/x/y/ b.yaml; echo 2>&1 > c.txt", "/w").map((w) => `${w.how} ${w.path}`)).toEqual([
      "sed -i /w/s/x/y",
      "sed -i /a/s/x/y",
      "sed -i /w/b.yaml",
      "sed -i /a/b.yaml",
      "the redirection > /w/c.txt",
      "the redirection > /a/c.txt",
    ]);
  });

  test("command substitutions, subshells, nested shells and command prefixes are read", () => {
    const f = "models/wh/orders.yaml";
    for (const c of [
      `out=$(sed -i s/a/b/ ${f})`,
      `echo \`sed -i s/a/b/ ${f}\``,
      `echo "$(cat x > ${f})"`,
      `(cd /tmp); sed -i s/a/b/ ${f}`,
      `cd /tmp && cd - && sed -i s/a/b/ ${f}`,
      `pushd /tmp; popd; sed -i s/a/b/ ${f}`,
      `bash -ec "sed -i s/a/b/ ${f}"`,
      `bash -e -c "sed -i s/a/b/ ${f}"`,
      `bash <<EOF\nsed -i s/a/b/ ${f}\nEOF`,
      `bash <<< "sed -i s/a/b/ ${f}"`,
      `sudo -u me sed -i s/a/b/ ${f}`,
      `patch ${f} < /tmp/x.diff`,
      "sed -i s/a/b/ {models,goldens}/wh/orders.yaml",
    ])
      refused(sh(c, root), "models/wh/orders.yaml");
  });

  test("perl without -i is a read, and -M does not count as -i", () => {
    allowed(sh(`perl -Mstrict -ne print ${model()}`));
    refused(sh(`perl -Mstrict -i -pe 's/a/b/' ${model()}`), "(perl -i)");
  });

  test("removing or moving semantic.yaml is refused; overwriting it is not", () => {
    refused(sh("mv semantic.yaml /tmp/s.yaml", root), "marks the semantic layer");
    refused(sh(`rm -f ${root}/semantic.yaml`), "marks the semantic layer");
    allowed(sh("echo 'name: hooktest' > semantic.yaml", root));
  });
});

describe("malformed input", () => {
  test("input that names no file fails open with a warning", () => {
    for (const raw of ["not json", "[]", JSON.stringify({ tool_name: "Edit" }), JSON.stringify({ tool_name: "Edit", tool_input: {} })]) {
      const v = checkToolUse(raw, dir);
      expect(v.allow).toBe(true);
      expect(v.message).toContain("not checked");
    }
  });

  test("other tools are allowed", () => {
    allowed(call("Read", { file_path: model() }));
  });

  test("unreadable input for a file inside a root fails closed", () => {
    refused(call("Edit", { file_path: model(), new_string: "x" }), "could not apply this edit", "old_string or new_string is missing");
    refused(call("Edit", { file_path: model(), old_string: "no such text", new_string: "x" }), "does not occur in the file");
    refused(call("Write", { file_path: model() }), "content is missing");
    refused(call("MultiEdit", { file_path: model(), edits: "x" }), "edits is missing");
  });

  test("YAML that would not parse is refused when the file holds approvals", () => {
    refused(edit(model(), "table: main.orders", "table: [main.orders"), "would not parse as YAML after this edit");
    allowed(edit(model("regions"), "table: main.regions", "table: [main.regions"));
    // Flow style in a file that does not parse is still read as an approval field.
    refused(edit(model("regions"), "table: main.regions", "table: [main.regions\nextra: { name: x, status: approved }"), "would not parse");
  });

  test("a file with approvals that does not parse may be repaired, if the repair leaves every approval as recorded", () => {
    const copy = join(dir, "conflict");
    cpSync(root, copy, { recursive: true });
    const f = join(copy, "models", "wh", "orders.yaml");
    const good = read(f);
    writeFileSync(f, good.replace(/^grain: (.*)$/m, "<<<<<<< HEAD\ngrain: $1\n=======\ngrain: other\n>>>>>>> b"));
    const g = join(copy, "goldens", "revenue_2025.yaml");
    writeFileSync(g, read(g).replace("question:", "<<<<<<< HEAD\nquestion:"));
    before = tree(dir);
    allowed(call("Write", { file_path: f, content: good }));
    allowed(call("Edit", { file_path: f, old_string: "<<<<<<< HEAD\ngrain: One row per order.\n=======\ngrain: other\n>>>>>>> b", new_string: "grain: One row per order." }));
    refused(call("Write", { file_path: f, content: good.replace("table: main.orders", "table: x") }), "approved wh.orders would not match", "git checkout -- models/wh/orders.yaml");
    refused(call("Write", { file_path: f, content: good.replace("    status: draft", "    status: draft\n    approved_by: Test Owner") }), "would add an approval field (approved_by)");
    refused(call("Write", { file_path: g, content: "name: revenue_2025\nstatus: approved\n" }), "cannot match its approval fields to the rows a confirmed golden records", "git checkout -- goldens/revenue_2025.yaml");
    // A draft model's repair may not change a join an approved field of another model reads through.
    const c = join(copy, "models", "wh", "customers.yaml");
    const draft = read(c);
    writeFileSync(f, good);
    writeFileSync(c, `${draft}<<<<<<< HEAD\n`);
    before = tree(dir);
    allowed(call("Write", { file_path: c, content: draft }));
    refused(call("Write", { file_path: c, content: draft.replace("from: region_id", "from: home_region_id") }), "approved wh.orders.revenue_ne would not match");
  });

  test("approval fields added while repairing a file that does not parse are refused", () => {
    const copy = join(dir, "broken");
    cpSync(root, copy, { recursive: true });
    const f = join(copy, "models", "wh", "regions.yaml");
    writeFileSync(f, read(f).replace("table: main.regions", "table: [main.regions"));
    before = tree(dir);
    refused(call("Edit", { file_path: f, old_string: "table: [main.regions", new_string: "table: main.regions\nextra: { status: approved }" }), "does not parse as YAML now");
    allowed(call("Edit", { file_path: f, old_string: "table: [main.regions", new_string: "table: main.regions" }));
  });
});

describe("the plugin registers the hook", () => {
  const plugin = JSON.parse(read(join(REPO, ".claude-plugin", "plugin.json"))) as {
    hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
  };
  const entry = plugin.hooks.PreToolUse[0]!;

  test("for every tool that writes files, and for Read", () => {
    expect(entry.matcher.split("|").sort()).toEqual(["Bash", "Edit", "MultiEdit", "NotebookEdit", "Read", "Write"]);
    expect(entry.hooks[0]!.type).toBe("command");
  });

  async function runHook(payload: unknown): Promise<{ code: number; err: string; ms: number }> {
    const start = performance.now();
    const p = Bun.spawn(["sh", "-c", entry.hooks[0]!.command], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO }, stdin: "pipe", stderr: "pipe", stdout: "pipe" });
    p.stdin.write(JSON.stringify(payload));
    await p.stdin.end();
    const code = await p.exited;
    return { code, err: await new Response(p.stderr).text(), ms: performance.now() - start };
  }

  test("the command exits 2 with the reason on stderr, and 0 for an allowed call", async () => {
    const no = await runHook({ tool_name: "Edit", cwd: dir, tool_input: { file_path: model(), old_string: "table: main.orders", new_string: "table: x" } });
    expect(no.code).toBe(2);
    expect(no.err).toContain("wh.orders is approved");
    const yes = await runHook({ tool_name: "Edit", cwd: dir, tool_input: { file_path: model(), old_string: "expr: order_id", new_string: "expr: id" } });
    expect(yes).toMatchObject({ code: 0, err: "" });
    // Typically well under 300 ms; the bound leaves room for a loaded CI machine.
    expect(yes.ms).toBeLessThan(3000);
  });
});

describe("on the Acme example", () => {
  let acme: string;
  beforeAll(() => {
    acme = tempDir("hook-acme");
    cpSync(join(REPO, "examples", "acme", "semantic"), acme, { recursive: true });
  });

  test("an approved measure is guarded and checking it is fast", () => {
    const f = join(acme, "models", "warehouse", "orders.yaml");
    const start = performance.now();
    refused(call("Edit", { file_path: f, old_string: "expr: ship_region\n", new_string: "expr: upper(ship_region)\n" }), "warehouse.orders.ship_region is approved");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("a refusal lists at most five items", () => {
    const v = call("Write", { file_path: join(acme, "models", "warehouse", "orders.yaml"), content: "model: orders\n" });
    expect(v.allow).toBe(false);
    expect(v.message!.split("\n").length).toBe(7);
    expect(v.message).toMatch(/and \d+ more approved items\.$/);
  });
});
