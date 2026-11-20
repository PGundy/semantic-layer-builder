import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { itemMap } from "../skills/semantic-layer/scripts/lib/changeset.ts";
import { appendEntry } from "../skills/semantic-layer/scripts/lib/release.ts";
import { approveWithYes, semlayer } from "./helpers.ts";
import { releaseFixture } from "./release-fixture.ts";

// semlayer add-segment and remove-segment (spec: Metric semantics, Segments), on a copy of the example layer.

const SALES = "status in ('completed', 'shipped')";
const FILTER = ["--source", "warehouse", "--model", "orders", "--name", "sales"];
const ADD = ["add-segment", ...FILTER, "--filter", SALES, "--description", "Orders that count as sales."];
const file = (root: string) => join(root, "models", "warehouse", "orders.yaml");
const read = (root: string) => readFileSync(file(root), "utf8");

interface Err {
  error: string;
  code: string;
  next?: string;
}
const refusal = (r: { code: number; out: string }) => {
  expect(r.code).toBe(1);
  return JSON.parse(r.out) as Err;
};

// The layer with segment `sales` named by the approved measure warehouse.orders.revenue, which the owner has approved again.
async function named(): Promise<string> {
  const root = releaseFixture();
  expect((await semlayer(root, ADD)).code).toBe(0);
  const set = await semlayer(root, ["set", "warehouse.orders.revenue", "segments", "[sales]"]);
  expect(set.err).toBe("");
  expect(set.code).toBe(0);
  const ok = await approveWithYes(root, ["--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"]);
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  return root;
}

describe("add-segment and remove-segment", () => {
  test("remove-segment after add-segment leaves the model file byte for byte as before", async () => {
    const root = releaseFixture();
    const before = read(root);
    const added = await semlayer(root, ADD);
    expect(added.err).toBe("");
    expect(added.code).toBe(0);
    expect(read(root)).toContain("segments:\n  - name: sales\n    filter: status in ('completed', 'shipped')");
    expect((await semlayer(root, ["validate"])).code).toBe(0);
    const gone = await semlayer(root, ["remove-segment", ...FILTER]);
    expect(gone.err).toBe("");
    expect(gone.code).toBe(0);
    expect(read(root)).toBe(before);
    // A second segment goes after the first and leaves the key when one remains.
    await semlayer(root, ADD);
    await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "big", "--filter", "amount_cents >= 10000"]);
    expect((await semlayer(root, ["remove-segment", ...FILTER])).code).toBe(0);
    expect(read(root)).toContain("segments:\n  - name: big");
  });

  test("an apply batch writes the same YAML as the commands", async () => {
    const one = releaseFixture();
    const two = releaseFixture();
    for (const args of [ADD, ["set", "warehouse.orders.revenue", "segments", "[sales]"]]) expect((await semlayer(one, args)).code).toBe(0);
    const edits = JSON.stringify({ edits: [ADD, ["set", "warehouse.orders.revenue", "segments", "[sales]"]] });
    const path = join(two, "..", "edits.json");
    writeFileSync(path, edits);
    const applied = await semlayer(two, ["apply", "--file", path]);
    expect(applied.err).toBe("");
    expect(applied.code).toBe(0);
    expect(read(two)).toBe(read(one));
    // And a batch that removes it again.
    writeFileSync(path, JSON.stringify({ edits: [["set", "warehouse.orders.revenue", "segments", "[]"], ["remove-segment", ...FILTER]] }));
    expect((await semlayer(two, ["apply", "--file", path])).code).toBe(0);
    expect(read(two)).not.toContain("- name: sales\n");
  });

  test("the readback of a model lists its segments with the measures that name them, and a measure's shows its conditions", async () => {
    const root = await named();
    const model = await semlayer(root, ["readback", "--targets", "warehouse.orders"]);
    expect(model.code).toBe(0);
    expect(model.out).toContain("- Segments (named conditions its measures can add to their own):");
    expect(model.out).toMatch(/sales: keeps rows where .*completed.*shipped.*Named by revenue\./);
    const measure = await semlayer(root, ["readback", "--targets", "warehouse.orders.revenue"]);
    expect(measure.out).toContain("(segment sales)");
  });

  test("every refusal is a UserError with a code and a next command, before anything is written", async () => {
    const root = releaseFixture();
    const before = read(root);
    await semlayer(root, ADD);
    const taken = refusal(await semlayer(root, [...ADD, "--json"]));
    expect(taken).toMatchObject({ code: "segment_exists", next: "semlayer add-segment --help" });
    expect(taken.error).toContain("--replace");
    expect(refusal(await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "other", "--filter", "x = 1", "--replace", "--json"])).code).toBe("segment_missing");
    const withSegment = read(root);
    // A filter is checked as a measure filter is: a subquery, a write, a dotted name that is neither a
    // column nor a join, an ignored column. A bare name is not judged, since a keyword and a column
    // cannot be told apart by name; semlayer check-rule runs the filter against the database.
    for (const [filter, code] of [
      ["order_id in (select order_id from refunds)", "expr.subquery"],
      ["status = 'x'; drop table orders", "expr.not_one_expression"],
      ["no_such_join.some_column = 1", "expr.unknown_name"],
    ] as const) {
      const r = refusal(await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "bad", "--filter", filter, "--json"]));
      expect(r.code).toBe(code);
      expect(r.next).toMatch(/^semlayer (add-segment --help|tables --source warehouse)$/);
      expect(read(root)).toBe(withSegment);
    }
    const ignored = refusal(await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "gift", "--filter", "gift_message is not null", "--json"]));
    expect(ignored.error).toContain("ignored_columns");
    expect(read(root)).toBe(withSegment);
    expect(refusal(await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "Bad Name", "--filter", "x = 1", "--json"])).code).toBe("usage");
    expect(before).not.toBe(withSegment);
    // A model that does not exist is refused with a code and a next command, by both commands.
    for (const cmd of ["add-segment", "remove-segment"]) {
      const r = refusal(await semlayer(root, [cmd, "--source", "warehouse", "--model", "nope", "--name", "sales", ...(cmd === "add-segment" ? ["--filter", "x = 1"] : []), "--json"]));
      expect(r.next).toBe("semlayer status");
    }
    // Valid PostgreSQL keywords such as ARRAY are not taken for column names.
    const arr = await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "arr", "--filter", "status = any(array['a','b'])"]);
    expect(arr.err).toBe("");
    expect(arr.code).toBe(0);
    // Nor are keywords no list would hold, and the output names the command that runs the filter.
    const kw = await semlayer(root, ["add-segment", ...FILTER.slice(0, 4), "--name", "kw", "--filter", "status similar to '(a|b)%' and order_id between symmetric 9 and 1"]);
    expect(kw.code).toBe(0);
    expect(kw.out).toContain("semlayer check-rule --source warehouse --model orders --filter");
  });

  test("remove-segment of a segment a measure or a golden names is refused, naming them", async () => {
    const root = await named();
    const r = refusal(await semlayer(root, ["remove-segment", ...FILTER, "--json"]));
    expect(r).toMatchObject({ code: "segment_in_use", next: "semlayer status" });
    expect(r.error).toContain("measure warehouse.orders.revenue (approved)");
    expect(r.error).toContain("semlayer apply");
    const gone = await semlayer(root, ["remove-segment", ...FILTER.slice(0, 4), "--name", "nope", "--json"]);
    expect(refusal(gone).code).toBe("segment_missing");
    // A golden whose request names it keeps it as well.
    const rooted = releaseFixture();
    await semlayer(rooted, ADD);
    writeFileSync(
      join(rooted, "goldens", "sales_count.yaml"),
      "name: sales_count\nquestion: How many sales?\nstatus: draft\nrequest:\n  source: warehouse\n  measures: [orders.order_count]\n  segments: [orders.sales]\n",
    );
    const g = refusal(await semlayer(rooted, ["remove-segment", ...FILTER, "--json"]));
    expect(g.code).toBe("segment_in_use");
    expect(g.error).toContain("golden sales_count");
  });

  test("add-segment --replace of a segment an approved measure names sends that measure back for approval, by name, and every report agrees", async () => {
    const root = await named();
    expect((await semlayer(root, ["validate"])).code).toBe(0);
    // A hand edit of the segment's filter is refused by the guard hook, naming the measure.
    const hand = checkToolUse(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file(root), old_string: `filter: ${SALES}`, new_string: "filter: status = 'completed'" },
        cwd: root,
      }),
    );
    expect(hand.allow).toBe(false);
    expect(hand.message).toContain("warehouse.orders.revenue is approved");

    const text = await semlayer(root, ["add-segment", ...FILTER, "--filter", "status = 'completed'", "--replace"]);
    expect(text.err).toBe("");
    expect(text.code).toBe(0);
    expect(text.out).toContain("warehouse.orders.revenue is approved and changed since its approval");
    expect(text.out).toContain("semlayer readback --targets warehouse.orders.revenue");
    expect(read(root)).toContain("filter: status = 'completed'");
    expect(read(root)).toContain("description: Orders that count as sales.");

    // validate, status and change status say the same of that one measure.
    const validate = await semlayer(root, ["validate", "--json"]);
    expect(validate.out).toContain("warehouse.orders.revenue changed since it was approved");
    const status = (await semlayer(root, ["status", "--json"])).json<{ changed_since_approval?: string[] }>();
    expect(status.changed_since_approval).toEqual(["warehouse.orders.revenue"]);
    // The next readback shows the new conditions.
    const readback = await semlayer(root, ["readback", "--targets", "warehouse.orders.revenue"]);
    expect(readback.out).toContain("(segment sales)");
    expect(readback.out).toContain("status equals 'completed' (segment sales)");
    expect(readback.out).not.toContain("'shipped' (segment");

    // Approving again on the owner's yes settles it.
    expect((await approveWithYes(root, ["--target", "warehouse.orders.revenue", "--by", "Dana Ruiz"])).code).toBe(0);
    expect((await semlayer(root, ["validate"])).code).toBe(0);
    expect((await semlayer(root, ["status", "--json"])).json<{ changed_since_approval?: string[] }>().changed_since_approval ?? []).toEqual([]);
  });

  test("the --json output of --replace names the measures that name the segment and the ones to approve again", async () => {
    const root = await named();
    const r = (await semlayer(root, ["add-segment", ...FILTER, "--filter", "status = 'shipped'", "--replace", "--json"])).json<{ reapprove: string[]; affected: string[]; measures: string[]; replaced: boolean; next: string }>();
    expect(r).toMatchObject({ replaced: true, reapprove: ["warehouse.orders.revenue"], affected: ["warehouse.orders.revenue"], measures: ["warehouse.orders.revenue"] });
    expect(r.next).toContain("semlayer readback --targets warehouse.orders.revenue");
    // A segment no measure names changes no approval.
    const free = releaseFixture();
    await semlayer(free, ADD);
    const again = (await semlayer(free, ["add-segment", ...FILTER, "--filter", "status = 'shipped'", "--replace", "--json"])).json<{ reapprove: string[]; measures: string[] }>();
    expect(again).toMatchObject({ reapprove: [], measures: [] });
  });

  test("a segment replace shows the measures that name it as changed in semlayer change status", async () => {
    const root = await named();
    appendEntry(root, {
      version: "1.0",
      date: "2026-02-03",
      note: "First release.",
      items: Object.fromEntries([...itemMap(root)].map(([ref, v]) => [ref, v.hash])),
      goldens: {},
      added: [],
      changed: [],
      removed: [],
      goldens_moved: [],
    });
    const clean = (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string }[] }>();
    expect(clean.changed).toEqual([]);
    expect((await semlayer(root, ["add-segment", ...FILTER, "--filter", "status = 'completed'", "--replace"])).code).toBe(0);
    const s = (await semlayer(root, ["change", "status", "--json"])).json<{ changed: { ref: string; state: string }[] }>();
    expect(s.changed.map((c) => c.ref)).toEqual(["warehouse.orders.revenue"]);
  });

  test("the commands are in the apply list and the tool list", async () => {
    const help = await semlayer(releaseFixture(), ["add-segment", "--help"]);
    expect(help.out).toContain("--replace");
  });
});
