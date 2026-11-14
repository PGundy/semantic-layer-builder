import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse, type Verdict } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import type { LedgerReply } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { duckdbSource, initProject, refsUnder, sl, tempRoot } from "./helpers.ts";

// docs/PRD-hardening.md HR-15, exit condition 4: one owner turn in at most three commands. sl reply
// --answers --approve records the answers and runs the approve and confirm they allow, through
// sl approve --readback's and sl goldens confirm --readback's own code (invariant 5: each item still
// rests on its own recorded yes to it as it stands). sl apply names every refused entry at once.
// Copies of examples/acme and small DuckDB projects; all data is synthetic.

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const SKILL = join(import.meta.dir, "..", "skills", "semantic-layer");
const SL = join(SKILL, "scripts", "sl.ts");
const OWNER = "Dana Ruiz";

let root = "";
let dir = "";
beforeEach(async () => {
  ({ root, dir } = tempRoot());
  cpSync(ACME, root, { recursive: true });
  // A locked command that changes nothing, so the lock's own .gitignore line is there before any copy.
  expect((await sl(root, ["set", "warehouse.orders", "grain", "One row per order."])).code).toBe(0);
});
afterEach(() => undefined);

// Every file under `at`, by path, with its text.
function files(at: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(at, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(at, p), "utf8"));
    }
  };
  walk("");
  return out;
}

let n = 0;
function jsonFile(data: unknown): string {
  const file = join(dir, `input-${++n}.json`);
  writeFileSync(file, JSON.stringify(data));
  return file;
}

function twin(from: string): string {
  const t = tempRoot();
  cpSync(from, t.root, { recursive: true });
  return t.root;
}

const ledger = (at: string) => (existsSync(join(at, ".sl", "ledger.jsonl")) ? readFileSync(join(at, ".sl", "ledger.jsonl"), "utf8") : "");
const lines = (at: string) => ledger(at).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerReply);

// Makes the models drafts and reads them back; returns the readback id and its items.
async function readBack(at: string, models: string[]): Promise<{ id: string; items: { n: number; target: string }[] }> {
  const targets = models.flatMap((m) => refsUnder(at, m));
  for (const m of models) expect((await sl(at, ["approve", "--target", m, "--revoke", "--recursive"])).code).toBe(0);
  const r = await sl(at, ["readback", "--targets", targets.join(","), "--json"]);
  expect(r.err).toBe("");
  const { readback_id, items } = r.json<{ readback_id: string; items: { n: number; target: string }[] }>();
  return { id: readback_id, items };
}

// The two ways to record a turn, side by side: --approve on `a`, the answers then approve and confirm on `b`.
async function bothWays(a: string, b: string, id: string, answers: unknown, two: string[][]): Promise<{ one: Awaited<ReturnType<typeof sl>>; codes: number[] }> {
  const file = jsonFile(answers);
  const one = await sl(a, ["reply", "--readback", id, "--answers", file, "--approve"]);
  const codes = [(await sl(b, ["reply", "--readback", id, "--answers", file])).code];
  for (const args of two) codes.push((await sl(b, args)).code);
  return { one, codes };
}

describe("sl reply --answers --approve is sl reply --answers then the approve and confirm", () => {
  test("a readback mixing yes, change and no: ledger and layer files byte for byte, and the same exit code", async () => {
    const { id, items } = await readBack(root, ["warehouse.refunds"]);
    const other = twin(root);
    const answers = {
      by: OWNER,
      answers: [
        { items: items.filter((i) => i.n !== 2 && i.n !== 3).map((i) => i.n), verdict: "yes", text: "Yes, those read right." },
        { item: 2, verdict: "change", text: "Call it the refund date." },
        { item: 3, verdict: "no", text: "That is not how we count refunds." },
      ],
    };
    const { one, codes } = await bothWays(root, other, id, answers, [["approve", "--readback", id]]);
    expect(one.err).toBe("");
    expect(one.code).toBe(codes[1]!);
    expect(one.code).toBe(0);
    expect(files(root)).toEqual(files(other));
    expect(lines(root)).toHaveLength(items.length);
    // The output is the reply's, then sl approve --readback's own report, then what is left to do.
    expect(one.out).toContain(`Recorded ans_0001 to ans_000${items.length} in .sl/ledger.jsonl`);
    expect(one.out).toContain(`Approved ${items.length - 2} of the ${items.length} items of ${id} answered now, each on the owner's own yes to it as it stands:`);
    expect(one.out).toContain(`  - ${items[1]!.target} (item 2): the owner's latest reply (ans_`);
    expect(one.out).toContain(`Next: make the changes the owner asked for to ${items[1]!.target}, ${items[2]!.target} with one sl apply --file -, then sl readback --targets ${items[1]!.target},${items[2]!.target}.`);
    expect(one.out).not.toContain("Next: sl approve --readback");
    for (const i of items) expect(JSON.stringify(readYaml(join(root, "models", "warehouse", "refunds.yaml")))).toContain(i.target.split(".").pop()!);
  });

  test("--json keeps the reply's fields and adds the approve's own output", async () => {
    const { id, items } = await readBack(root, ["warehouse.refunds"]);
    const r = await sl(root, ["reply", "--readback", id, "--answers", jsonFile({ by: OWNER, answers: [{ items: items.map((i) => i.n), verdict: "yes", text: "Yes, all of them." }] }), "--approve", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json<{ readback_id: string; ids: string[]; entries: unknown[]; warnings: string[]; next: string; next_steps: string[]; approval: { approved: { target: string }[]; all_yes_approved: boolean } }>();
    expect(out.ids).toHaveLength(items.length);
    expect(out.approval.approved.map((a) => a.target)).toEqual(expect.arrayContaining(items.map((i) => i.target)));
    expect(out.approval.all_yes_approved).toBe(true);
    expect(out.next).toBe("sl next");
    expect(out).not.toHaveProperty("confirmation");
  });

  test("an item changed since its readback: the answers stay, it is not approved, the same files and exit 1", async () => {
    const { id, items } = await readBack(root, ["warehouse.refunds"]);
    // The model's primary key changes after the readback: item 1 (the model) no longer stands as read back.
    expect((await sl(root, ["set", "warehouse.refunds", "primary_key", "refund_id,order_id"])).code).toBe(0);
    const other = twin(root);
    const answers = { by: OWNER, answers: [{ items: items.map((i) => i.n), verdict: "yes", text: "Yes, all of them." }] };
    const { one, codes } = await bothWays(root, other, id, answers, [["approve", "--readback", id]]);
    expect(codes).toEqual([0, 1]);
    expect(one.code).toBe(1);
    expect(files(root)).toEqual(files(other));
    expect(lines(root)).toHaveLength(items.length);
    expect(one.out).toContain("warehouse.refunds changed since it was read back");
    expect(one.out).toContain("  - warehouse.refunds (item 1): ");
    expect(one.out).toContain("1 item(s) the owner said yes to were not approved (listed above with why); fix each as its line says.");
    expect(one.out).toContain("Next: sl readback --targets warehouse.refunds.");
    expect(readYaml<{ status: string }>(join(root, "models", "warehouse", "refunds.yaml")).status).toBe("draft");
  });

  test("goldens: confirmed as sl goldens confirm --readback confirms them, byte for byte, a change named", async () => {
    const t = await goldensProject(3);
    const rb = await sl(t, ["readback", "--targets", "golden:g1,golden:g2,golden:g3", "--tolerance", "0", "--json"]);
    expect(rb.code).toBe(0);
    const id = rb.json<{ readback_id: string; batched: { reply_approve: string } }>().readback_id;
    expect(rb.json<{ batched: { reply_approve: string } }>().batched.reply_approve).toBe(`sl reply --readback ${id} --answers - --approve`);
    const other = twin(t);
    const answers = { by: OWNER, answers: [{ items: [1, 2], verdict: "yes", text: "Those match the pack." }, { item: 3, verdict: "change", text: "Leave out region west." }] };
    const { one, codes } = await bothWays(t, other, id, answers, [["goldens", "confirm", "--readback", id]]);
    // The goldens have no layer request, so each confirm says on stderr that its rows come from its cross_check_sql.
    expect(one.err).not.toContain("sl reply:");
    expect([one.code, ...codes]).toEqual([0, 0, 0]);
    expect(files(t)).toEqual(files(other));
    expect(one.out).toContain(`Confirmed 2 of the 3 goldens of ${id} answered now, each on the owner's own yes to its rows and tolerance:`);
    expect(one.out).toContain(`  - golden:g3 (item 3): the owner's latest reply (ans_0003, to item 3 of ${id}) is "change", not yes.`);
    expect(readYaml<{ status: string }>(join(t, "goldens", "g1.yaml")).status).toBe("approved");
    expect(readYaml<{ status: string }>(join(t, "goldens", "g3.yaml")).status).toBe("draft");
  });

  test("a golden changed since its readback is not confirmed: the answer stays, exit 1, as the two-step form", async () => {
    const t = await goldensProject(1);
    const id = (await sl(t, ["readback", "--targets", "golden:g1", "--tolerance", "0", "--json"])).json<{ readback_id: string }>().readback_id;
    writeGolden(t, "g1", "select count(*) + 1 as n from orders");
    const other = twin(t);
    const { one, codes } = await bothWays(t, other, id, { by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes." }] }, [["goldens", "confirm", "--readback", id]]);
    expect([one.code, ...codes]).toEqual([1, 0, 1]);
    expect(files(t)).toEqual(files(other));
    expect(one.out).toContain("golden:g1 (item 1): the golden, the rows its request compiles to now or the tolerance changed since the owner said yes");
    expect(lines(t)).toHaveLength(1);
  });
});

describe("refusals", () => {
  test("--approve goes with --answers only; the single form and a bad answers file write nothing", async () => {
    const { id } = await readBack(root, ["warehouse.refunds"]);
    const before = files(root);
    const single = await sl(root, ["reply", "--readback", id, "--item", "1", "--text", "Yes.", "--verdict", "yes", "--by", OWNER, "--approve"]);
    expect(single.code).toBe(1);
    expect(single.err).toContain("--approve goes with --answers, which records the turn's answers first");
    expect(single.err).toContain("sl approve --target <ref>");
    const bad = await sl(root, ["reply", "--readback", id, "--answers", jsonFile({ by: OWNER, answers: [{ item: 99, verdict: "yes", text: "Yes." }] }), "--approve"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Nothing was written");
    expect((await sl(root, ["reply", "--readback", id, "--answers", jsonFile({ by: OWNER, answers: [] }), "--approve", "--by", OWNER])).err).toContain("--answers takes no --by");
    expect(files(root)).toEqual(before);
  });

  test("a golden read back from --results is left to its own confirm, named, and does not fail the command", async () => {
    const t = await goldensProject(1);
    const results = join(dir, "rows.json");
    writeFileSync(results, JSON.stringify({ "golden:g1:cross_check": [{ n: 2 }] }));
    const rb = await sl(t, ["readback", "--targets", "golden:g1", "--tolerance", "0", "--results", results, "--json"]);
    expect(rb.code).toBe(0);
    const { readback_id: id, items } = rb.json<{ readback_id: string; items: { rows_from?: string }[] }>();
    expect(items[0]!.rows_from).toBe(`--results ${results}`);
    const r = await sl(t, ["reply", "--readback", id, "--answers", jsonFile({ by: OWNER, answers: [{ item: 1, verdict: "yes", text: "Yes, two orders." }] }), "--approve"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  - golden:g1 (item 1): it was read back from stored rows (--results ${results}), which only its own confirm reads. Next: sl goldens confirm --name g1 --results ${results}.`);
    expect(r.out).toContain(`Next: sl goldens confirm --name g1 --results ${results}.`);
    expect(readYaml<{ status: string }>(join(t, "goldens", "g1.yaml")).status).toBe("draft");
    const confirm = await sl(t, ["goldens", "confirm", "--name", "g1", "--results", results]);
    expect(confirm.code).toBe(0);
    expect(readYaml<{ status: string }>(join(t, "goldens", "g1.yaml")).status).toBe("approved");
  });
});

describe("roles and the hook", () => {
  const bash = (agent: string | undefined, command: string): Verdict => {
    const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd: dir, hook_event_name: "PreToolUse" };
    if (agent) Object.assign(payload, { agent_type: agent, agent_id: "a1b2c3" });
    return checkToolUse(JSON.stringify(payload));
  };
  const reply = `bun ${SL} reply --readback rb_0001 --answers - --approve <<'JSON'\n{"by": "Dana", "answers": [{"item": 1, "verdict": "yes", "text": "Yes."}]}\nJSON`;
  const approve = `bun ${SL} approve --readback rb_0001`;

  test("the interviewer and the main agent may run it, as the two-step form", () => {
    for (const agent of [undefined, "sl-interviewer", "semantic-layer:sl-interviewer"]) {
      for (const command of [reply, approve]) expect({ agent, command, ...bash(agent, command) }).toEqual({ agent, command, allow: true, message: undefined } as never);
    }
  });

  test("every other role is refused it with the words sl approve gets", () => {
    for (const agent of ["sl-connector-runner", "sl-batch-analyst", "sl-readback-verifier", "sl-golden-builder"]) {
      const a = bash(agent, approve);
      const r = bash(agent, reply);
      expect(a.allow).toBe(false);
      expect(r.allow).toBe(false);
      // The same sentence, with the command it names.
      expect(r.message!.replace("sl reply", "sl approve")).toBe(a.message!);
      expect(r.message).toContain("sl reply acts on the owner's recorded answers, and only the interviewer, who talks to the owner, runs it.");
    }
  });
});

// The fourth exit walkthrough's last turn: eight goldens read back and answered yes, three open
// questions answered and one new question raised took four commands; here it takes three.
describe("the fourth walkthrough's turns", () => {
  test("eight goldens answered yes, three questions answered, one new question: three commands", async () => {
    const t = await goldensProject(8);
    mkdirSync(join(t, "models", "wh"), { recursive: true });
    writeFileSync(join(t, "models", "wh", "orders.yaml"), "model: orders\ntable: main.orders\nstatus: draft\n");
    for (const q of ["Do refunds count as orders?", "Which region owns online orders?", "Is amount before tax?"])
      expect((await sl(t, ["question", "add", "wh.orders", "--text", q])).code).toBe(0);
    const names = Array.from({ length: 8 }, (_, i) => `golden:g${i + 1}`);
    const rb = await sl(t, ["readback", "--targets", names.join(","), "--tolerance", "0"]);
    expect(rb.out).toContain("Record the owner's answers in one sl reply --readback rb_0001 --answers - --approve, each item with its own verdict and their words: it confirms every golden they said yes to as it stands.");
    let commands = 0;
    const run = async (args: string[]) => {
      commands++;
      const r = await sl(t, args);
      expect({ args, code: r.code, refused: r.err.includes(`sl ${args[0]}:`) }).toEqual({ args, code: 0, refused: false });
      return r;
    };
    await run(["reply", "--readback", "rb_0001", "--answers", jsonFile({ by: OWNER, answers: [{ items: [1, 2, 3, 4, 5, 6, 7, 8], verdict: "yes", text: "Every one of those matches the pack." }] }), "--approve"]);
    await run([
      "question", "resolve", "--answers",
      jsonFile({ by: OWNER, answers: [
        { target: "wh.orders", match: "refunds", text: "No." },
        { target: "wh.orders", match: "online orders", text: "East." },
        { target: "wh.orders", match: "before tax", text: "Yes." },
      ] }),
    ]);
    await run(["apply", "--file", jsonFile({ edits: [["question", "add", "wh.orders", "--text", "Should cancelled orders show in the count?"]] })]);
    expect(commands).toBe(3);
    for (let i = 1; i <= 8; i++) expect(readYaml<{ status: string }>(join(t, "goldens", `g${i}.yaml`)).status).toBe("approved");
    expect(readYaml<{ open_questions: string[] }>(join(t, "models", "wh", "orders.yaml")).open_questions).toEqual(["Should cancelled orders show in the count?"]);
    expect(lines(t).map((l) => l.kind as string)).toEqual([...Array(8).fill("reply"), "question", "question", "question"]);
  });

  test("its 43-edit turn with three mistakes: one refusal names all three, writing nothing; fixed, it lands: two commands", async () => {
    const fields = (model: string) => {
      const m = readYaml<{ dimensions?: { name: string }[]; measures?: { name: string }[] }>(join(root, "models", "warehouse", `${model}.yaml`));
      return [...(m.dimensions ?? []), ...(m.measures ?? [])].map((f) => `warehouse.${model}.${f.name}`);
    };
    const described = readdirSync(join(root, "models", "warehouse")).map((f) => f.replace(/\.yaml$/, "")).flatMap(fields).slice(0, 40).map((ref, i) => ["set", ref, "description", `Synthetic description ${i + 1}.`]);
    expect(described).toHaveLength(40);
    const mistakes = [
      ["set", "warehouse.orders", "filter", "status <> 'test'"],
      ["set", "warehouse.orders.order_date", "time_zone", "America/New_York"],
      ["set", "warehouse.order_items", "primary_key", "{order_item_id}"],
    ];
    const edits = [...described.slice(0, 10), mistakes[0]!, ...described.slice(10, 25), mistakes[1]!, ...described.slice(25), mistakes[2]!];
    expect(edits).toHaveLength(43);
    const at = mistakes.map((m) => edits.indexOf(m) + 1);
    let commands = 0;
    const before = files(root);
    commands++;
    const r = await sl(root, ["apply", "--file", jsonFile({ edits })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("3 entries are refused, so nothing was written:");
    expect(r.err).toContain(`Entry ${at[0]} (sl set warehouse.orders filter "status <> 'test'"): A model has no filter`);
    expect(r.err).toContain(`Entry ${at[1]} (sl set warehouse.orders.order_date time_zone America/New_York): Cannot set time_zone`);
    expect(r.err).toContain("write the expr as created_at at time zone 'America/New_York'");
    expect(r.err).toContain(`Entry ${at[2]} (sl set warehouse.order_items primary_key {order_item_id}): `);
    expect(files(root)).toEqual(before);
    // The fixes: the rule on each measure (as the refusal names it), no time_zone, the list either way.
    const named = r.err.split("\n").find((l) => l.startsWith(`Entry ${at[0]} `))!;
    const perMeasure = JSON.parse(`[${named.slice(named.indexOf("sl apply --file -: ") + 19, named.indexOf(" (on their own: "))}]`) as string[][];
    expect(perMeasure.map((e) => e[1])).toEqual(["warehouse.orders.order_count", "warehouse.orders.revenue", "warehouse.orders.discount"]);
    const fixed = [...described, ...perMeasure, ["set", "warehouse.order_items", "primary_key", "order_item_id,order_id"]];
    commands++;
    const ok = await sl(root, ["apply", "--file", jsonFile({ edits: fixed })]);
    expect({ code: ok.code, err: ok.err }).toEqual({ code: 0, err: "" });
    expect(commands).toBe(2);
    expect(readYaml<{ primary_key: string[] }>(join(root, "models", "warehouse", "order_items.yaml")).primary_key).toEqual(["order_item_id", "order_id"]);
  });
});

describe("sl apply checks every entry", () => {
  test("a later entry that reads what a refused entry would create is not checked, and not reported as its own error", async () => {
    const before = files(root);
    const r = await sl(root, ["apply", "--file", jsonFile({ edits: [
      ["add-field", "warehouse.orders", "--kind", "measure", "--name", "refund_net", "--agg", "sum", "--expr", "no_such_column"],
      ["set", "warehouse.orders.refund_net", "description", "Net of refunds."],
      ["set", "warehouse.orders.nope", "description", "Not a field."],
      ["set", "warehouse.orders", "grain", "One row per order."],
    ] })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 entries are refused and 1 not checked, so nothing was written:");
    expect(r.err).toContain("Entry 1 (sl add-field warehouse.orders --kind measure --name refund_net --agg sum --expr no_such_column): ");
    expect(r.err).toContain("Entry 3 (sl set warehouse.orders.nope description \"Not a field.\"): ");
    expect(r.err).toContain("Entry 2 was not checked: it reads what entry 1 would have created.");
    expect(r.err).not.toContain("Entry 2 (sl set");
    expect(files(root)).toEqual(before);
  });

  test("a word in free text that matches a refused entry's name is not a reference: each entry keeps its own error", async () => {
    const before = files(root);
    const r = await sl(root, ["apply", "--file", jsonFile({ edits: [
      ["add-metric", "--name", "test", "--type", "ratio", "--source", "warehouse", "--numerator", "orders.nope", "--denominator", "orders.order_count"],
      ["set", "warehouse.orders.nope_field", "description", "A test row."],
      ["set", "warehouse.orders.nope_field2", "description", "Excludes test accounts"],
      ["set", "metric:test", "description", "Reads the refused metric."],
    ] })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("3 entries are refused and 1 not checked, so nothing was written:");
    for (const n of [1, 2, 3]) expect(r.err).toContain(`Entry ${n} (`);
    expect(r.err).toContain("Entry 4 was not checked: it reads what entry 1 would have created.");
    expect(files(root)).toEqual(before);
  });

  test("entries that do not parse are named with the ones that fail to run", async () => {
    const r = await sl(root, ["apply", "--file", jsonFile({ edits: [["set", "warehouse.orders", "grain", "x", "--bogus"], ["profile", "--source", "warehouse"], ["set", "warehouse.nope", "grain", "x"]] })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("3 entries are refused, so nothing was written:");
    for (const n of [1, 2, 3]) expect(r.err).toContain(`Entry ${n} (`);
  });
});

describe("the texts behind the walkthrough's mistakes", () => {
  test("sl set takes a list of names as a,b or [a, b], and says so in --help", async () => {
    const other = twin(root);
    expect((await sl(root, ["set", "warehouse.order_items", "primary_key", "order_item_id,order_id"])).code).toBe(0);
    expect((await sl(other, ["set", "warehouse.order_items", "primary_key", "[order_item_id, order_id]"])).code).toBe(0);
    expect(readFileSync(join(root, "models", "warehouse", "order_items.yaml"), "utf8")).toBe(readFileSync(join(other, "models", "warehouse", "order_items.yaml"), "utf8"));
    expect(readYaml<{ primary_key: string[] }>(join(root, "models", "warehouse", "order_items.yaml")).primary_key).toEqual(["order_item_id", "order_id"]);
    expect((await sl(root, ["set", "warehouse.order_items", "primary_key", "order_item_id,"])).err).toContain("primary_key has an empty name");
    const help = await sl(root, ["set", "--help"]);
    expect(help.out).toContain("A list of names (primary_key, tags, synonyms, time_grains, a role's");
    expect(help.out).toContain("is written a,b or [a, b]: primary_key order_id,line_no and primary_key '[order_id, line_no]' write the same.");
    expect(help.out).toContain("One name is written [a], as primary_key '[order_id]'.");
    expect(help.out).not.toContain("A list is written a,b.");
  });

  test("a model-level filter is refused with the one sl apply that puts the rule on each measure", async () => {
    const r = await sl(root, ["set", "warehouse.refunds", "filter", "reason <> 'test'"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("A model has no filter: a rule that holds for every figure of warehouse.refunds goes on each measure's filter. Write it on every measure with this entry in the turn's sl apply --file -:");
    expect(r.err).toContain(`["set", "warehouse.refunds.refund_amount", "filter", `);
    expect((await sl(root, ["set", "--help"])).out).toContain("A model has no filter");
    const card = readFileSync(join(SKILL, "references", "phases", "interview.md"), "utf8");
    expect(card).not.toMatch(/`primary_key`, `filter`, `synonyms`/);
    expect(card).toContain("A model has no `filter`: a rule that holds for every figure of a model goes on each measure's `filter`");
  });

  test("the time_zone refusal gives the expr for the column and the zone asked for, and how days are counted without it", async () => {
    const r = await sl(root, ["set", "warehouse.orders.order_date", "time_zone", "America/New_York"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "remove time_zone, and to count days in America/New_York write the expr as created_at at time zone 'America/New_York' (without it, days are counted in UTC when sl runs the query)",
    );
    expect(r.err).not.toContain("convert in expr");
  });

  test("the cards and the skill name the one-command form", () => {
    const read = (p: string) => readFileSync(join(SKILL, p), "utf8");
    for (const p of ["references/phases/interview.md", "references/phases/access.md", "references/phases/verify.md", "SKILL.md"])
      expect({ p, names: read(p).includes("--answers - --approve") }).toEqual({ p, names: true });
    expect(read("references/phases/interview.md")).toContain("each owner turn in at most three commands: `sl apply --file -`, `sl question resolve --answers -`, `sl reply --answers - --approve`");
  });

  test("sl next asks for a multi-item readback's answers with the one-command form", async () => {
    const { id } = await readBack(root, ["warehouse.refunds"]);
    const next = await sl(root, ["next", "--json"]);
    expect(next.json<{ why: string }>().why).toContain(`approve each yes in one sl reply --readback ${id} --answers - --approve (one answer alone: sl reply --readback ${id} --item <n>`);
  });
});

// A DuckDB project with `count` goldens, g1 ... gN, each a count of orders read from its cross_check_sql.
async function goldensProject(count: number): Promise<string> {
  const t = tempRoot();
  await initProject(t.root);
  await duckdbSource(t.root, t.dir, "wh", ["create table orders (id integer, region varchar)", "insert into orders values (1, 'east'), (2, 'west')"]);
  for (let i = 1; i <= count; i++) writeGolden(t.root, `g${i}`, i % 2 ? "select count(*) as n from orders" : "select count(*) as n from orders where region = 'east'");
  return t.root;
}

function writeGolden(at: string, name: string, sql: string): void {
  writeFileSync(join(at, "goldens", `${name}.yaml`), `name: ${name}\nquestion: ${name}?\nrequest:\n  source: wh\nsql: ${sql}\nstatus: draft\n`);
}
