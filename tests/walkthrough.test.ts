// The exit walkthrough's harness (evals/walkthrough/): count.ts over a hand-written log, and w.sh
// run against a temp directory with this checkout's hooks.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerCommands, count, type Entry, recordsAnswers, slCommand } from "../evals/walkthrough/count.ts";
import { tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const SL = "bun /plugin/skills/semantic-layer/scripts/sl.ts";
const SECRET = "s3cret-walk-pw";

// One log entry: NNNN.json and its output NNNN.out.
function write(dir: string, n: number, entry: Omit<Entry, "n">, out = ""): void {
  const id = String(n).padStart(4, "0");
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(entry)}\n`);
  writeFileSync(join(dir, `${id}.out`), out);
}
const run = (text: string, exit = 0, extra: Partial<Entry> = {}): Omit<Entry, "n"> => ({ kind: "run", text, exit, bytes: 10, refused: false, changed_layer: false, undone: false, ...extra });

describe("count.ts", () => {
  test("names the sl command of the short and the full form", () => {
    expect(slCommand("sl next --json")).toBe("next");
    expect(slCommand(`${SL} apply --file -`)).toBe("apply");
    expect(slCommand(`${SL} question list | head`)).toBe("question list");
    expect(slCommand("sl goldens confirm --readback rb_0002")).toBe("goldens confirm");
    expect(slCommand("cat semantic/semantic.yaml")).toBeUndefined();
  });

  test("finds sl after a pipe, &&, ;, an env assignment or global flags, and not in a heredoc body", () => {
    expect(slCommand("cat <<EOF | sl apply --file -\n{}\nEOF")).toBe("apply");
    expect(slCommand("printf x | sl question resolve --answers -")).toBe("question resolve");
    expect(slCommand("SL_ENV_FILE=.env sl apply --file x")).toBe("apply");
    expect(slCommand("cd /w && sl tag a pii")).toBe("tag");
    expect(slCommand("true; sl set a b c")).toBe("set");
    expect(slCommand("sl --root semantic apply --file -")).toBe("apply");
    expect(slCommand(`${SL} --json --env-file=.env question add x --text q`)).toBe("question add");
    expect(slCommand("cat <<EOF > notes.txt\nsl apply --file -\nEOF")).toBeUndefined();
    const e = (text: string): Entry => ({ n: "0001", ...run(text) });
    expect(answerCommands(e("sl apply --file a.json && sl question resolve --answers b.json"))).toEqual(["apply", "question resolve"]);
    expect(answerCommands(e("sl goldens new --name revenue_2025 --question q"))).toEqual(["goldens new"]);
    expect(recordsAnswers(e("sl question resolve --answers - <<A\nthe owner said --help is fine\nA"))).toBe(true);
  });

  test("counts an owner turn's commands as the successful ones that record answers, and the other exit conditions", () => {
    const dir = tempDir("walk-log");
    let n = 0;
    write(dir, ++n, { kind: "read", text: "/plugin/skills/semantic-layer/SKILL.md", exit: 0, bytes: 15000, refused: false, changed_layer: false });
    write(dir, ++n, run("sl next --json"), '{"kind":"ask_owner"}');
    write(dir, ++n, { kind: "owner", text: "What is one order?", exit: 0, bytes: 20, refused: false, changed_layer: false });
    write(dir, ++n, run(`${SL} apply --file - <<'EDITS'\n{"edits": []}\nEDITS`, 0, { changed_layer: true }));
    write(dir, ++n, run(`${SL} approve --help`));
    write(dir, ++n, run(`${SL} question list | head -5`));
    write(dir, ++n, run("sl question resolve --answers -", 1), "Error: no such question");
    write(dir, ++n, run(`${SL} readback --targets wh.orders`));
    write(dir, ++n, run(`${SL} reply --readback rb_0001 --answers -`));
    write(dir, ++n, { kind: "read", text: "/walk/work/.env", exit: 2, bytes: 0, refused: true, changed_layer: false });
    write(dir, ++n, run("python3 edit.py", 0, { changed_layer: true, undone: true }));
    write(dir, ++n, { kind: "read", text: "/plugin/skills/semantic-layer/references/interview-guide.md", exit: 0, bytes: 20 * 1024, refused: false, changed_layer: false });
    write(dir, ++n, { kind: "owner", text: "Who may see emails?", exit: 0, bytes: 20, refused: false, changed_layer: false });
    write(dir, ++n, run(`${SL} setup --source wh --check`), `connected as postgres://ro:${SECRET}@db/acme`);
    write(dir, ++n, run(`${SL} tag wh.customers.email pii`));
    const c = count(dir, SECRET);
    expect(c.commands_per_owner_turn).toEqual([2, 1]);
    expect(c.most_commands_for_one_owner_turn).toMatchObject({ turn: "0003", count: 2 });
    expect(c.most_commands_for_one_owner_turn!.commands[1]).toBe(`${SL} reply --readback rb_0001 --answers -`);
    expect(c.owner_turns).toBe(2);
    expect(c.commands_that_failed).toEqual(["0007 [exit 1] sl question resolve --answers -"]);
    expect(c.refused_by_hook).toEqual(["0010 read: /walk/work/.env"]);
    expect(c.undone_by_hook).toEqual(["0011 python3 edit.py"]);
    expect(c.layer_changed_by_a_non_sl_command).toEqual(["0011 python3 edit.py"]);
    expect(c.reads_over_12_kb).toEqual([{ file: "references/interview-guide.md", kb: 20 }]);
    expect(c.read_spec_md).toBe(false);
    expect(c.secret_in_log).toEqual([`0014 run: ${SL} setup --source wh --check`]);
    expect(c.secret_in_transcript).toBe("not checked");
    expect(c.sl_by_command).toMatchObject({ next: 1, apply: 1, approve: 1, "question list": 1, "question resolve": 1, readback: 1, reply: 1, setup: 1, tag: 1 });
  });

  test("a --help call, a list, a readback, a failed, refused or undone command records no answer", () => {
    const yes = (text: string, extra: Partial<Entry> = {}) => recordsAnswers({ n: "0001", ...run(text), ...extra });
    for (const t of ["sl apply --file -", "sl set wh.orders grain x", "sl question add wh.orders --text q", "sl goldens confirm --readback rb_0003", `${SL} add-join --source wh`])
      expect(yes(t), t).toBe(true);
    for (const t of ["sl apply --help", "sl tag -h", "sl question list", "sl question list | wc -l", "sl readback --targets x", "sl check-rule --source wh", "sl goldens check", "sl validate"])
      expect(yes(t), t).toBe(false);
    expect(yes("sl apply --file -", { exit: 1 })).toBe(false);
    expect(yes("sl reply --readback rb_0001 --answers -", { undone: true })).toBe(false);
  });
});

// w.sh needs bash and bun on PATH.
const hasShell = Bun.which("bash") !== null && Bun.which("bun") !== null;

describe("w.sh", () => {
  test.skipIf(!hasShell)("refuses a read of the project's .env after an sl command, and logs the refusal", () => {
    const walk = realpathSync(tempDir("walk"));
    mkdirSync(join(walk, "work"));
    writeFileSync(join(walk, "work", ".env"), `WAREHOUSE_URL=postgresql://reader:${SECRET}@localhost/acme\n`);
    const env = { ...process.env, WALK: walk, PLUGIN: REPO };
    const w = (...args: string[]) => Bun.spawnSync(["bash", join(REPO, "evals", "walkthrough", "w.sh"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const first = w("run", `bun ${join(REPO, "skills", "semantic-layer", "scripts", "sl.ts")} next`);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain("sl init --name <name>");
    const read = w("read", ".env");
    expect(read.exitCode).toBe(2);
    expect(read.stdout.toString()).toContain("refused Read");
    const log = join(walk, "log");
    expect(JSON.parse(readFileSync(join(log, "0002.json"), "utf8"))).toMatchObject({ kind: "read", exit: 2, refused: true });
    expect(readFileSync(join(log, "0002.out"), "utf8")).toContain("refused Read");
    const c = count(log, SECRET);
    expect(c.refused_by_hook).toEqual([`0002 read: ${join(walk, "work", ".env")}`]);
    expect(c.secret_in_log).toEqual([]);
    expect(c.sl_by_command).toEqual({ next: 1 });
  }, 60_000);
});
