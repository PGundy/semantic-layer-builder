// The --json error envelope: every failing command prints one {error, code, next?} object on stdout,
// its stderr line and exit code unchanged, and a failed MCP tool call carries the same object.
import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { COMMANDS } from "../skills/semantic-layer/scripts/commands/index.ts";
import type { CommandSpec } from "../skills/semantic-layer/scripts/lib/command.ts";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { isRegistered } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
import { toolResult } from "../skills/semantic-layer/scripts/mcp/elicit.ts";
import { FIXED_NOW, initProject, semlayer, tempDir, tempRoot } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const SCHEMAS = join(REPO, "skills", "semantic-layer", "schemas");
const SERVER = join(REPO, "skills", "semantic-layer", "scripts", "mcp", "server.ts");
const ACME = join(REPO, "examples", "acme", "semantic");

const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
const schema = (name: string) => ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, `${name}.schema.json`), "utf8")) as object);
const errorSchema = schema("cli-error");
const issueSchema = schema("issue");

interface Envelope {
  error: string;
  code: string;
  next?: string;
}

// Runs the CLI with exactly `args` (no --root added), in `cwd`.
async function raw(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { cwd, env: { SEMLAYER_NOW: FIXED_NOW, ...env }, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function envelope(out: string): Envelope {
  const body = JSON.parse(out) as Envelope;
  expect(errorSchema(body)).toBe(true);
  // A family.name code is registered; a bare word is a refusal that is no validate issue.
  if (body.code.includes(".")) expect(isRegistered(body.code)).toBe(true);
  return body;
}

// A copy of the Acme example with one draft measure, warehouse.orders.gross, that no owner has said yes to.
async function acme(): Promise<string> {
  const root = join(tempDir("cli-errors-acme"), "semantic");
  cpSync(ACME, root, { recursive: true });
  const add = ["add-field", "warehouse.orders", "--kind", "measure", "--name", "gross", "--expr", "amount_cents * 0.01", "--agg", "sum", "--description", "Gross order value."];
  expect((await semlayer(root, add)).code).toBe(0);
  return root;
}

describe("the --json error envelope", () => {
  test("status --root /nonexistent --json is no_layer with its next, and the exit code is unchanged", async () => {
    const r = await raw(["status", "--root", "/nonexistent", "--json"], REPO);
    expect(r.code).toBe(1);
    expect(envelope(r.out)).toEqual({
      error: "No semantic layer at /nonexistent. Run `semlayer init --name <name>` first, or pass --root.",
      code: "no_layer",
      next: "semlayer init --name <name>",
    });
    expect(r.err).toBe("semlayer status: No semantic layer at /nonexistent. Run `semlayer init --name <name>` first, or pass --root.");
    const plain = await raw(["status", "--root", "/nonexistent"], REPO);
    expect(plain.code).toBe(1);
    expect(plain.out).toBe("");
  });

  test("a usage error and an unknown command are usage, naming the help to read", async () => {
    const flag = await raw(["status", "--bogus", "--json"], REPO);
    expect(flag.code).toBe(1);
    const body = envelope(flag.out);
    expect(body.code).toBe("usage");
    expect(body.next).toBe("semlayer status --help");
    expect(flag.err).toBe(`semlayer status: ${body.error}`);
    const unknown = await raw(["no-such-command", "--json"], REPO);
    expect(unknown.code).toBe(1);
    expect(envelope(unknown.out)).toEqual({ error: 'Unknown command "no-such-command". Run `semlayer help` for the list.', code: "usage", next: "semlayer help" });
    expect(unknown.err).toBe('Unknown command "no-such-command". Run `semlayer help` for the list.');
    // Without --json nothing reaches stdout; after "--" the word is a positional, not the flag.
    expect((await raw(["no-such-command"], REPO)).out).toBe("");
    expect((await raw(["no-such-command", "--", "--json"], REPO)).out).toBe("");
  });

  test("an error in the tool itself is internal with exit 2, its stack trace still on stderr", async () => {
    const spec: CommandSpec = {
      summary: "Throws.",
      usage: "cli-errors-throws",
      options: {},
      writes: false,
      run() {
        throw new TypeError("something broke inside");
      },
    };
    COMMANDS["cli-errors-throws"] = async () => ({ default: spec });
    try {
      const r = await raw(["cli-errors-throws", "--json"], REPO);
      expect(r.code).toBe(2);
      expect(envelope(r.out)).toEqual({ error: "something broke inside", code: "internal" });
      expect(r.err).toStartWith("semlayer cli-errors-throws: unexpected error: TypeError: something broke inside\n");
      expect((await raw(["cli-errors-throws"], REPO)).out).toBe("");
    } finally {
      delete COMMANDS["cli-errors-throws"];
    }
  });

  test("the errors an agent branches on carry their codes", async () => {
    const t = tempRoot();
    await initProject(t.root);
    const answers = join(t.dir, "answers.json");
    writeFileSync(answers, "[1, 2]");
    const root = await acme();
    const cases: [string, string[], string, string?][] = [
      [t.root, ["approve", "--target", "a.b.c.d"], "bad_target"],
      [t.root, ["reply", "--readback", "rb_0001", "--answers", join(t.dir, "missing.json")], "input_unreadable"],
      [t.root, ["reply", "--readback", "rb_0001", "--answers", answers], "input_invalid"],
      [t.root, ["status", "--env-file", join(t.dir, "no-such.env")], "source.connection_missing"],
      [root, ["approve", "--target", "warehouse.orders.gross"], "approval.no_ledger_yes"],
      [root, ["set", "warehouse.orders.order_date", "time_zone", "UTC"], "time.zone_carries_own"],
      [t.root, ["status", "--source", "nope"], "user_error"],
    ];
    for (const [at, args, code] of cases) {
      const r = await semlayer(at, [...args, "--json"]);
      expect(r.code).toBe(1);
      const body = envelope(r.out);
      expect([args.join(" "), body.code]).toEqual([args.join(" "), code]);
      expect(r.err.endsWith(body.error)).toBe(true);
    }
  });

  test("semlayer apply passes on the code of its refused entries, batch_refused when they differ", async () => {
    const root = await acme();
    const run = async (edits: string[][]) => {
      const f = join(tempDir(), "t.json");
      writeFileSync(f, JSON.stringify({ edits }));
      const r = await semlayer(root, ["apply", "--file", f, "--json"]);
      expect(r.code).toBe(1);
      return envelope(r.out).code;
    };
    const zone = ["set", "warehouse.orders.order_date", "time_zone", "UTC"];
    expect(await run([zone])).toBe("time.zone_carries_own");
    expect(await run([zone, ["set", "warehouse.refunds.order_date", "time_zone", "UTC"]])).toBe("time.zone_carries_own");
    expect(await run([zone, ["set", "warehouse.orders.nope", "description", "x"]])).toBe("batch_refused");
  });

  test("a readback semlayer approve would refuse is readback_blocked, with semlayer apply as its next", async () => {
    const root = await acme();
    expect((await semlayer(root, ["set", "warehouse.orders.gross", "format", "currency"])).code).toBe(0);
    const r = await semlayer(root, ["readback", "--targets", "warehouse.orders.gross", "--json"]);
    expect(r.code).toBe(1);
    expect(envelope(r.out)).toMatchObject({ code: "readback_blocked", next: "semlayer apply --file -" });
  });

  test("stderr is byte-identical with and without --json for ten sampled errors", async () => {
    const t = tempRoot();
    await initProject(t.root);
    const root = await acme();
    const samples: [string[], string][] = [
      [["status", "--root", "/nonexistent"], REPO],
      [["no-such-command"], REPO],
      [["status", "--bogus", "--root", t.root], REPO],
      [["approve", "--target", "a.b.c.d", "--root", t.root], REPO],
      [["approve", "--target", "warehouse.orders.gross", "--root", root], REPO],
      [["set", "warehouse.orders.order_date", "time_zone", "UTC", "--root", root], REPO],
      [["status", "--source", "nope", "--root", t.root], REPO],
      [["status", "--env-file", join(t.dir, "no-such.env"), "--root", t.root], REPO],
      [["reply", "--readback", "rb_0001", "--answers", join(t.dir, "missing.json"), "--root", t.root], REPO],
      [["approve", "--root", t.root], REPO],
    ];
    for (const [args, cwd] of samples) {
      const plain = await raw(args, cwd);
      const json = await raw([...args, "--json"], cwd);
      expect(plain.code).toBe(1);
      expect(json.code).toBe(plain.code);
      expect(json.err).toBe(plain.err);
      expect(plain.out).toBe("");
      envelope(json.out);
    }
    expect((await raw(["approve", "--target", "a.b.c.d", "--root", t.root, "--json"], REPO)).err).toBe(
      'semlayer approve: Cannot read target "a.b.c.d". Use source.model, source.model.field, metric:<name>, golden:<name> or access.',
    );
  });

  test("a command that printed its own JSON before failing prints no second object", async () => {
    const root = await acme();
    writeFileSync(join(root, "semantic.yaml"), "name: broken\n");
    const r = await semlayer(root, ["validate", "--json"]);
    expect(r.code).toBe(1);
    const body = r.json<{ ok: boolean; issues: unknown[] }>();
    expect(body.ok).toBe(false);
    expect("code" in body).toBe(false);
    // Real validate --json issues match the issue schema.
    for (const issue of body.issues) expect([issue, issueSchema(issue)]).toEqual([issue, true]);
    const valid = await semlayer(await acme(), ["validate", "--json"]);
    for (const issue of valid.json<{ issues: unknown[] }>().issues) expect([issue, issueSchema(issue)]).toEqual([issue, true]);
  });
});

describe("a failed MCP tool call", () => {
  test("toolResult carries the envelope as structuredContent; text and isError stay", async () => {
    const r = await raw(["status", "--root", "/nonexistent", "--json"], REPO);
    const result = toolResult("status", r);
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text)).toEqual([r.out, r.err]);
    expect(result.structuredContent).toEqual(JSON.parse(r.out));
    expect(errorSchema(result.structuredContent)).toBe(true);
    // A success, or a failure whose output is not the envelope, carries none.
    expect(toolResult("status", { code: 0, out: "{}", err: "" }).structuredContent).toBeUndefined();
    expect(toolResult("validate", { code: 1, out: '{"ok": false}', err: "" }).structuredContent).toBeUndefined();
  });

  test("the server's tools/call result of a refused command validates against the schema", async () => {
    const root = await acme();
    const proc = Bun.spawn(["bun", SERVER, "--root", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SEMLAYER_NOW: FIXED_NOW },
    });
    const send = (m: object) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ id: 2, method: "tools/call", params: { name: "semlayer_approve", arguments: { target: "warehouse.orders.gross" } } });
    proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
    await proc.exited;
    const call = lines.map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> }).find((m) => m.id === 2)!;
    expect(call.result.isError).toBe(true);
    const structured = call.result.structuredContent as Envelope;
    expect(errorSchema(structured)).toBe(true);
    expect(structured.code).toBe("approval.no_ledger_yes");
    expect((call.result.content as { text: string }[])[0]!.text).toBe(JSON.stringify(structured, null, 2));
  });
});
