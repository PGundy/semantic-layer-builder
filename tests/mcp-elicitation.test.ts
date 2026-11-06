// MCP elicitation for approve and confirm (PRD FR-7.1): with a client that declares elicitation, the
// owner answers the readback in the client and only their yes approves (invariant 5).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_VALUE } from "../skills/semantic-layer/scripts/lib/output.ts";
import type { PendingReadback } from "../skills/semantic-layer/scripts/lib/types.ts";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { ANSWER_SCHEMA, readbackMessage } from "../skills/semantic-layer/scripts/mcp/elicit.ts";
import { duckdbSource, FIXED_NOW, initProject, refsUnder, sl, tempRoot } from "./helpers.ts";

const SERVER = join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "mcp", "server.ts");
const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");
const TARGET = "warehouse.products.launched_on";

type Msg = Record<string, any>;
// What the scripted owner does with one elicitation/create: a result to send, an error to send, or
// nothing (the owner never answers).
type Script = (params: Msg) => { result: Msg } | { error: Msg } | "ignore";

// A client that declares (or not) elicitation and answers the server's elicitation/create requests from a script.
class Client {
  readonly proc;
  readonly fromServer: Msg[] = [];
  readonly elicited: Msg[] = [];
  private waiting = new Map<number, (m: Msg) => void>();
  private buffer = "";
  private nextId = 1;
  private reading: Promise<void>;
  script: Script = () => "ignore";

  constructor(args: string[]) {
    this.proc = Bun.spawn(["bun", SERVER, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, SL_NOW: FIXED_NOW } });
    this.reading = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl)) as Msg;
        this.buffer = this.buffer.slice(nl + 1);
        this.fromServer.push(msg);
        if (msg.method === "elicitation/create") {
          this.elicited.push(msg);
          const answer = this.script(msg.params);
          if (answer !== "ignore") this.send({ jsonrpc: "2.0", id: msg.id, ...answer });
        } else if (typeof msg.id === "number") {
          this.waiting.get(msg.id)?.(msg);
          this.waiting.delete(msg.id);
        }
      }
    }
  }

  send(msg: Msg): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    this.proc.stdin.flush();
  }

  request(method: string, params?: unknown): Promise<Msg> {
    const id = this.nextId++;
    const p = new Promise<Msg>((done) => this.waiting.set(id, done));
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return p;
  }

  async init(elicitation: boolean | Msg): Promise<void> {
    const capabilities = typeof elicitation === "object" ? elicitation : elicitation ? { elicitation: {} } : {};
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: "scripted", version: "1" } });
    expect(r.error).toBeUndefined();
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  call(name: string, args: Record<string, unknown>): Promise<Msg> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await this.proc.exited;
    await this.reading;
  }
}

const accept = (content: Msg): Script => () => ({ result: { action: "accept", content } });
const texts = (r: Msg) => (r.result.content as { text: string }[]).map((c) => c.text);
const ownerAnswer = (r: Msg) => JSON.parse(texts(r).at(-1)!) as { owner_answer: Msg; message: string };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function acme(elicitation: boolean | Msg = true, extra: string[] = []) {
  const t = tempRoot();
  cpSync(ACME, t.root, { recursive: true });
  const client = new Client(["--root", t.root, ...extra]);
  cleanups.push(t.cleanup, () => client.close());
  await client.init(elicitation);
  const ledger = join(t.root, ".sl", "ledger.jsonl");
  const model = join(t.root, "models", "warehouse", "products.yaml");
  const lines = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Msg) : []);
  const status = () => readYaml<{ dimensions: Msg[] }>(model).dimensions.find((d) => d.name === "launched_on")!;
  const pending = (id: string) => JSON.parse(readFileSync(join(t.root, ".sl", "pending", `${id}.json`), "utf8")) as PendingReadback;
  return { ...t, client, ledger, model, lines, status, pending };
}

describe("approve with a client that declares elicitation", () => {
  test("accept with yes records the owner's reply exactly as sl reply does, then approves", async () => {
    const a = await acme();
    a.client.script = accept({ verdict: "yes", by: "Dana Ruiz", comment: "Yes, that is the launch date." });
    const r = await a.client.call("sl_approve", { target: TARGET });
    expect(r.result.isError).toBeUndefined();
    expect(a.client.elicited).toHaveLength(1);
    const req = a.client.elicited[0]!;
    expect(typeof req.id).toBe("string");
    expect(req.params.requestedSchema).toEqual(ANSWER_SCHEMA);
    expect(req.params.requestedSchema.properties.verdict.enum).toEqual(["yes", "no", "change"]);
    // The message is the readback text sl readback stored, for the item the yes is recorded against.
    const rb = a.pending("rb_0001");
    expect(req.params.message).toBe(rb.items[0]!.text);
    expect(req.params.message).toBe((await sl(a.root, ["readback", "--targets", TARGET, "--json"])).json<PendingReadback>().items[0]!.text);
    const [line] = a.lines();
    expect(line).toEqual({
      at: FIXED_NOW,
      by: "Dana Ruiz",
      content_hash: rb.items[0]!.content_hash,
      id: "ans_0001",
      item: 1,
      kind: "reply",
      readback_id: "rb_0001",
      target: TARGET,
      text: "Yes, that is the launch date.",
      verdict: "yes",
    });
    expect(a.status()).toMatchObject({ status: "approved", approved_by: "Dana Ruiz", approved_at: FIXED_NOW.slice(0, 10), approved_hash: rb.items[0]!.content_hash });
    // The approve's own JSON comes first; the owner's answer is the last item.
    expect(JSON.parse(texts(r)[0]!).changed).toEqual([{ target: TARGET, from: "draft", to: "approved" }]);
    expect(ownerAnswer(r).owner_answer).toEqual({ asked: "elicitation", action: "accept", verdict: "yes", by: "Dana Ruiz", readback_id: "rb_0001", recorded: ["ans_0001"] });
  });

  test("an accept with no comment records yes as the owner's words", async () => {
    const a = await acme();
    a.client.script = accept({ verdict: "yes", by: "Dana Ruiz" });
    await a.client.call("sl_approve", { target: TARGET });
    expect(a.lines()[0]).toMatchObject({ text: "yes", verdict: "yes", by: "Dana Ruiz" });
  });

  test("the owner's name and verdict are cleaned as sl reply cleans them", async () => {
    const a = await acme();
    a.client.script = accept({ verdict: " Yes ", by: "Dana\nRuiz" });
    const r = await a.client.call("sl_approve", { target: TARGET });
    expect(r.result.isError).toBeUndefined();
    expect(a.lines()[0]).toMatchObject({ by: "Dana Ruiz", verdict: "yes", text: "yes" });
    expect(a.status()).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
  });

  test("a call whose by is not the owner who said yes records the yes, approves nothing and says so", async () => {
    const a = await acme();
    a.client.script = accept({ verdict: "yes", by: "Dana Ruiz" });
    const r = await a.client.call("sl_approve", { target: TARGET, by: "Mallory" });
    expect(r.result.isError).toBe(true);
    expect(a.lines().map((l) => l.by)).toEqual(["Dana Ruiz"]);
    expect(a.status().status).toBe("draft");
    const { owner_answer, message } = ownerAnswer(r);
    expect(owner_answer).toMatchObject({ verdict: "yes", by: "Dana Ruiz", recorded: ["ans_0001"] });
    expect(message).toContain("but sl approve refused (its output is above), so nothing was approved. Next:");
    expect(message).toContain("leave by out), then call sl_approve again.");
  });

  test("metric, access and a model with joins (recursive) are asked and approve on yes", async () => {
    const a = await acme();
    for (const [target, recursive] of [["metric:net_revenue", false], ["access", false], ["warehouse.orders", true]] as const) {
      expect((await sl(a.root, ["approve", "--target", target, "--revoke", ...(recursive ? ["--recursive"] : [])])).code).toBe(0);
      a.client.script = accept({ verdict: "yes", by: "Dana Ruiz" });
      const n = a.client.elicited.length;
      const r = await a.client.call("sl_approve", { target, ...(recursive ? { recursive } : {}) });
      expect(a.client.elicited).toHaveLength(n + 1);
      expect(r.result.isError).toBeUndefined();
    }
    expect((await sl(a.root, ["status", "--json"])).code).toBe(0);
  });

  test("decline and cancel record nothing and approve nothing", async () => {
    const a = await acme();
    const before = readFileSync(a.model, "utf8");
    for (const action of ["decline", "cancel"]) {
      a.client.script = () => ({ result: { action } });
      const r = await a.client.call("sl_approve", { target: TARGET, by: "Dana Ruiz" });
      expect(r.result.isError).toBeUndefined();
      const { owner_answer, message } = ownerAnswer(r);
      expect(owner_answer).toMatchObject({ action, recorded: [] });
      expect(message).toContain("nothing was recorded and nothing was approved");
      expect(message).toContain("Next: call sl_approve again");
    }
    expect(existsSync(a.ledger)).toBe(false);
    expect(readFileSync(a.model, "utf8")).toBe(before);
  });

  test("change and no record the owner's reply and approve nothing", async () => {
    const a = await acme();
    const before = readFileSync(a.model, "utf8");
    a.client.script = accept({ verdict: "change", by: "Dana Ruiz", comment: "It is the first order date, not the launch." });
    const r = await a.client.call("sl_approve", { target: TARGET });
    expect(ownerAnswer(r).message).toContain("answered change; recorded ans_0001 in .sl/ledger.jsonl and nothing was approved. Next: make the change");
    a.client.script = accept({ verdict: "no", by: "Dana Ruiz" });
    await a.client.call("sl_approve", { target: TARGET });
    expect(a.lines().map((l) => [l.verdict, l.text, l.by])).toEqual([
      ["change", "It is the first order date, not the launch.", "Dana Ruiz"],
      ["no", "no", "Dana Ruiz"],
    ]);
    expect(readFileSync(a.model, "utf8")).toBe(before);
  });

  test("an accepted form without a verdict or a name records nothing", async () => {
    const a = await acme();
    for (const content of [{ verdict: "maybe", by: "Dana" }, { verdict: "yes", by: "  " }, { verdict: "yes" }, undefined]) {
      a.client.script = () => ({ result: { action: "accept", ...(content ? { content } : {}) } });
      const r = await a.client.call("sl_approve", { target: TARGET });
      expect(r.result.isError).toBe(true);
      expect(ownerAnswer(r).message).toContain("nothing was recorded and nothing was approved");
    }
    expect(existsSync(a.ledger)).toBe(false);
    expect(a.status().status).toBe("draft");
  });

  test("a yes already in the ledger from the agent is not enough: the owner is asked, and their decline approves nothing", async () => {
    const a = await acme();
    // The agent records a yes through the CLI, outside the server.
    const rb = (await sl(a.root, ["readback", "--targets", TARGET, "--json"])).json<PendingReadback>();
    expect((await sl(a.root, ["reply", "--readback", rb.readback_id, "--item", "1", "--text", "yes", "--verdict", "yes", "--by", "Dana Ruiz"])).code).toBe(0);
    a.client.script = () => ({ result: { action: "decline" } });
    await a.client.call("sl_approve", { target: TARGET, by: "Dana Ruiz" });
    expect(a.client.elicited).toHaveLength(1);
    expect(a.status().status).toBe("draft");
  });

  test("--recursive asks once with every item read back, and a yes records one reply per item", async () => {
    const a = await acme();
    expect((await sl(a.root, ["approve", "--target", "warehouse.regions", "--recursive", "--revoke"])).code).toBe(0);
    a.client.script = accept({ verdict: "yes", by: "Dana Ruiz" });
    const r = await a.client.call("sl_approve", { target: "warehouse.regions", recursive: true });
    expect(r.result.isError).toBeUndefined();
    const refs = refsUnder(a.root, "warehouse.regions");
    const rb = a.pending("rb_0001");
    expect(rb.items.map((i) => i.target)).toEqual(refs);
    expect(a.client.elicited[0]!.params.message).toBe(readbackMessage(rb.items));
    expect(a.client.elicited[0]!.params.message).toStartWith("1. warehouse.regions (table)");
    expect(a.lines().map((l) => [l.target, l.item, l.verdict])).toEqual(refs.map((ref, i) => [ref, i + 1, "yes"]));
    expect(JSON.parse(texts(r)[0]!).changed.map((c: Msg) => c.target)).toEqual(refs);
  });

  test("revoke needs no answer and asks nothing", async () => {
    const a = await acme();
    const r = await a.client.call("sl_approve", { target: "warehouse.regions", revoke: true });
    expect(r.result.isError).toBeUndefined();
    expect(a.client.elicited).toHaveLength(0);
  });

  test("a target that cannot be read back asks nothing and approves nothing", async () => {
    const a = await acme();
    const r = await a.client.call("sl_approve", { target: "warehouse.products.nope" });
    expect(r.result.isError).toBe(true);
    expect(texts(r).join("\n")).toContain('Unknown target "warehouse.products.nope"');
    expect(texts(r).at(-1)).toBe("The target could not be read back to the owner, so nothing was approved.");
    expect(a.client.elicited).toHaveLength(0);
  });
});

describe("the request and its response", () => {
  test("a timeout records nothing, cancels the request, and a late answer is ignored", async () => {
    const a = await acme(true, ["--elicit-timeout", "0.3"]);
    a.client.script = () => "ignore";
    const r = await a.client.call("sl_approve", { target: TARGET });
    expect(r.result.isError).toBe(true);
    expect(ownerAnswer(r).message).toContain("The owner's answer did not arrive within 0.3 seconds; nothing was recorded and nothing was approved.");
    expect(ownerAnswer(r).owner_answer).toEqual({ asked: "elicitation", outcome: "timeout", readback_id: "rb_0001", recorded: [] });
    const id = a.client.elicited[0]!.id;
    expect(a.client.fromServer.find((m) => m.method === "notifications/cancelled")?.params).toMatchObject({ requestId: id });
    a.client.send({ jsonrpc: "2.0", id, result: { action: "accept", content: { verdict: "yes", by: "Dana Ruiz" } } });
    expect((await a.client.request("ping")).result).toEqual({});
    expect(existsSync(a.ledger)).toBe(false);
    expect(a.status().status).toBe("draft");
  });

  test("a client that closes while the owner thinks records nothing, and the server exits", async () => {
    const a = await acme();
    const asked = new Promise<void>((done) => {
      a.client.script = () => {
        done();
        return "ignore";
      };
    });
    void a.client.call("sl_approve", { target: TARGET });
    await asked;
    a.client.proc.stdin.end();
    expect(await Promise.race([a.client.proc.exited, Bun.sleep(8000).then(() => "hung")])).toBe(0);
    expect(existsSync(a.ledger)).toBe(false);
    expect(a.status().status).toBe("draft");
  });

  test("only an elicitation object declares the capability, as of the latest initialize", async () => {
    const a = await acme({ elicitation: true });
    expect((await a.client.call("sl_approve", { target: TARGET })).result.isError).toBe(true);
    expect(a.client.elicited).toHaveLength(0);
    await a.client.init(true);
    a.client.script = () => ({ result: { action: "decline" } });
    await a.client.call("sl_approve", { target: TARGET });
    expect(a.client.elicited).toHaveLength(1);
  });

  test("--help names --elicit-timeout, and a timeout that is not seconds above 0 is refused", () => {
    expect(Bun.spawnSync(["bun", SERVER, "--help"]).stdout.toString()).toContain("--elicit-timeout <seconds>");
    for (const bad of ["0", "-1", "abc", "Infinity"]) {
      const b = Bun.spawnSync(["bun", SERVER, `--elicit-timeout=${bad}`]);
      expect(b.exitCode).toBe(1);
      expect(b.stderr.toString()).toContain("--elicit-timeout is a number of seconds above 0");
    }
  });

  test("an error response records nothing", async () => {
    const a = await acme();
    a.client.script = () => ({ error: { code: -32601, message: "Method not found" } });
    const r = await a.client.call("sl_approve", { target: TARGET });
    expect(r.result.isError).toBe(true);
    expect(ownerAnswer(r).message).toContain("The client could not ask the owner (Method not found); nothing was recorded");
    expect(existsSync(a.ledger)).toBe(false);
  });

  test("the server keeps answering while the owner thinks; responses are matched by id", async () => {
    const a = await acme();
    const asked = new Promise<Msg>((done) => {
      a.client.script = (params) => {
        done(params);
        return "ignore";
      };
    });
    const call = a.client.call("sl_approve", { target: TARGET });
    await asked;
    expect((await a.client.request("ping")).result).toEqual({});
    const id = a.client.elicited[0]!.id as string;
    expect(id).toMatch(/^sl-elicit-\d+$/);
    // A response with another id answers nothing.
    a.client.send({ jsonrpc: "2.0", id: "sl-elicit-999", result: { action: "accept", content: { verdict: "yes", by: "Mallory" } } });
    // Nor does a numeric id with the same number, or a request that reuses the server's id.
    a.client.send({ jsonrpc: "2.0", id: Number(id.replace(/\D/g, "")), result: { action: "accept", content: { verdict: "yes", by: "Mallory" } } });
    a.client.send({ jsonrpc: "2.0", id, method: "ping" });
    a.client.send({ jsonrpc: "2.0", id, result: { action: "accept", content: { verdict: "yes", by: "Dana Ruiz" } } });
    const r = await call;
    expect(r.result.isError).toBeUndefined();
    expect(a.lines().map((l) => l.by)).toEqual(["Dana Ruiz"]);
  });
});

describe("reply with verdict yes", () => {
  test("the agent's yes, words and name are not recorded; the owner's answer is", async () => {
    const a = await acme();
    const rb = (await sl(a.root, ["readback", "--targets", TARGET, "--json"])).json<PendingReadback>();
    a.client.script = () => ({ result: { action: "decline" } });
    const declined = await a.client.call("sl_reply", { readback: rb.readback_id, item: "1", text: "The owner said yes", verdict: " YES ", by: "Dana Ruiz" });
    expect(ownerAnswer(declined).message).toContain("nothing was recorded and no yes was recorded");
    expect(existsSync(a.ledger)).toBe(false);
    expect(a.client.elicited[0]!.params.message).toBe(rb.items[0]!.text);
    a.client.script = accept({ verdict: "change", by: "Lee Owner", comment: "Call it first sold on." });
    const changed = await a.client.call("sl_reply", { readback: rb.readback_id, item: "1", text: "yes", verdict: "yes", by: "Dana Ruiz" });
    expect(JSON.parse(texts(changed)[0]!).entry).toMatchObject({ verdict: "change", by: "Lee Owner", text: "Call it first sold on.", content_hash: rb.items[0]!.content_hash });
    expect(ownerAnswer(changed).message).toContain(`Next: ${JSON.parse(texts(changed)[0]!).next}.`);
    expect(a.lines()).toHaveLength(1);
  });

  test("a reply without a yes runs as on the CLI and asks nothing", async () => {
    const a = await acme();
    const rb = (await sl(a.root, ["readback", "--targets", TARGET, "--json"])).json<PendingReadback>();
    const r = await a.client.call("sl_reply", { readback: rb.readback_id, item: "1", text: "Not sure yet", by: "Dana Ruiz" });
    expect(r.result.isError).toBeUndefined();
    expect(a.lines()[0]).toMatchObject({ verdict: null, by: "Dana Ruiz" });
    expect(a.client.elicited).toHaveLength(0);
  });

  test("an unknown readback or item asks nothing and records nothing", async () => {
    const a = await acme();
    const rb = (await sl(a.root, ["readback", "--targets", TARGET, "--json"])).json<PendingReadback>();
    expect(texts(await a.client.call("sl_reply", { readback: "rb_0099", item: "1", text: "yes", verdict: "yes", by: "D" }))[0]).toContain('There is no readback "rb_0099"');
    expect(texts(await a.client.call("sl_reply", { readback: rb.readback_id, item: "7", text: "yes", verdict: "yes", by: "D" }))[0]).toContain("has no item");
    expect(a.client.elicited).toHaveLength(0);
    expect(existsSync(a.ledger)).toBe(false);
  });
});

describe("a client without elicitation", () => {
  test("gets 6.1's behaviour: no request is sent, and approve needs the yes already recorded", async () => {
    const a = await acme(false);
    const refused = await a.client.call("sl_approve", { target: TARGET });
    expect(refused.result.isError).toBe(true);
    expect(texts(refused).join("\n")).toBe((await sl(a.root, ["approve", "--target", TARGET, "--json"])).err);
    const rb = (await a.client.call("sl_readback", { targets: [TARGET] })).result.content[0].text;
    const id = JSON.parse(rb).readback_id;
    expect((await a.client.call("sl_reply", { readback: id, item: "1", text: "yes", verdict: "yes", by: "Dana Ruiz" })).result.isError).toBeUndefined();
    expect((await a.client.call("sl_approve", { target: TARGET })).result.isError).toBeUndefined();
    expect(a.status()).toMatchObject({ status: "approved", approved_by: "Dana Ruiz" });
    expect(a.client.elicited).toHaveLength(0);
  });

  test("the tool descriptions say how the owner's yes arrives", async () => {
    const without = await acme(false);
    const tools = (await without.client.request("tools/list")).result.tools as Msg[];
    const desc = (name: string) => tools.find((x) => x.name === name)!.description as string;
    expect(desc("sl_approve")).toContain("This client did not declare MCP elicitation");
    expect(desc("sl_approve")).toContain("A client that declares elicitation gives the owner's answer directly.");
    expect(desc("sl_goldens")).toContain("did not declare MCP elicitation");
    expect(desc("sl_reply")).toContain("lets the owner give this answer in the client directly");
    const withIt = await acme(true);
    const tools2 = (await withIt.client.request("tools/list")).result.tools as Msg[];
    expect(tools2.find((x) => x.name === "sl_approve")!.description).toContain("No yes is taken from the arguments.");
    expect(tools2.find((x) => x.name === "sl_status")!.description).not.toContain("elicitation");
  });
});

describe("goldens confirm", () => {
  async function golden() {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", [
      "create table customers (id integer, email varchar, city varchar)",
      "insert into customers values (1, 'ana.secret@example.com', 'Lisbon'), (2, 'bo.secret@example.com', 'Porto')",
    ]);
    const file = join(t.root, "goldens", "by_email.yaml");
    writeFileSync(
      file,
      "name: by_email\nquestion: Customers by email\nrequest:\n  source: wh\n  measures: [customers.n]\n  dimensions: [customers.city]\n" +
        "sql: select email, city, count(*) as n from customers group by email, city order by city\nstatus: draft\n",
    );
    const client = new Client(["--root", t.root]);
    cleanups.push(() => client.close());
    await client.init(true);
    return { ...t, client, file };
  }

  test("the message is the golden's readback, protected values masked; a yes confirms it", async () => {
    const g = await golden();
    g.client.script = accept({ verdict: "yes", by: "Dana Ruiz", comment: "Matches the CRM." });
    const r = await g.client.call("sl_goldens", { positionals: ["confirm"], name: "by_email", tolerance: "0" });
    const message = g.client.elicited[0]!.params.message as string;
    const stored = JSON.parse(readFileSync(join(g.root, ".sl", "pending", "rb_0001.json"), "utf8")) as PendingReadback;
    expect(message).toBe(stored.items[0]!.text);
    expect(message).toContain(PROTECTED_VALUE);
    expect(message).toContain("Tolerance: 0: later runs must give exactly these figures.");
    for (const secret of ["ana.secret@example.com", "bo.secret@example.com"]) expect(JSON.stringify(g.client.fromServer)).not.toContain(secret);
    expect(r.result.isError).toBeUndefined();
    expect(readYaml<Msg>(g.file)).toMatchObject({ status: "approved", confirmed_by: "Dana Ruiz" });
    expect(ownerAnswer(r).owner_answer).toMatchObject({ verdict: "yes", recorded: ["ans_0001"] });
  });

  test("a call whose by is not the owner who said yes confirms nothing and says so", async () => {
    const g = await golden();
    g.client.script = accept({ verdict: "yes", by: "Dana Ruiz" });
    const r = await g.client.call("sl_goldens", { positionals: ["confirm"], name: "by_email", by: "Mallory" });
    expect(r.result.isError).toBe(true);
    expect(readYaml<Msg>(g.file).status).toBe("draft");
    expect(ownerAnswer(r).message).toContain("but sl goldens confirm refused (its output is above), so nothing was confirmed. Next:");
  });

  test("a decline confirms nothing; run and --emit-sql ask nothing", async () => {
    const g = await golden();
    const before = readFileSync(g.file, "utf8");
    g.client.script = () => ({ result: { action: "decline" } });
    const r = await g.client.call("sl_goldens", { positionals: ["confirm"], name: "by_email" });
    expect(ownerAnswer(r).message).toContain("nothing was recorded and nothing was confirmed. Next: call sl_goldens confirm again");
    expect(readFileSync(g.file, "utf8")).toBe(before);
    expect(existsSync(join(g.root, ".sl", "ledger.jsonl"))).toBe(false);
    await g.client.call("sl_goldens", { positionals: ["run"], name: "by_email" });
    await g.client.call("sl_goldens", { positionals: ["confirm"], name: "by_email", "emit-sql": true });
    expect(g.client.elicited).toHaveLength(1);
  });
});

describe("the docs", () => {
  test("the spec's MCP server section documents elicitation", () => {
    const spec = readFileSync(join(import.meta.dir, "..", "skills", "semantic-layer", "references", "spec.md"), "utf8").replace(/\s+/g, " ");
    const section = spec.slice(spec.indexOf("## MCP server"), spec.indexOf("## CLI"));
    for (const phrase of [
      "**Elicitation.**",
      "`elicitation/create`",
      "`--elicit-timeout <seconds>`",
      "never taken from the tool's arguments",
      "`{ verdict: yes | no | change, by, comment? }`",
      "`outcome` (`timeout`, `closed` or `error`)",
      "A call that asks nothing ends without `owner_answer`",
    ])
      expect(section).toContain(phrase);
  });
});
