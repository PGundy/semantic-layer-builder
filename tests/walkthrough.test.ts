// The exit walkthrough's harness (evals/walkthrough/): count.ts over a hand-written log, and w.sh
// run against a temp directory with this checkout's hooks.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerCommands, count, type Entry, recordsAnswers, semlayerCommand } from "../evals/walkthrough/count.ts";
import { tempDir } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const SEMLAYER = "bun /plugin/skills/semantic-layer/scripts/semlayer.ts";
const SECRET = "s3cret-walk-pw";

// One log entry: NNNN.json and its output NNNN.out.
function write(dir: string, n: number, entry: Omit<Entry, "n">, out = ""): void {
  const id = String(n).padStart(4, "0");
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(entry)}\n`);
  writeFileSync(join(dir, `${id}.out`), out);
}
const run = (text: string, exit = 0, extra: Partial<Entry> = {}): Omit<Entry, "n"> => ({ kind: "run", text, exit, bytes: 10, refused: false, changed_layer: false, undone: false, ...extra });

describe("count.ts", () => {
  test("names the semlayer command of the short and the full form", () => {
    expect(semlayerCommand("semlayer next --json")).toBe("next");
    expect(semlayerCommand(`${SEMLAYER} apply --file -`)).toBe("apply");
    expect(semlayerCommand(`${SEMLAYER} question list | head`)).toBe("question list");
    expect(semlayerCommand("semlayer goldens confirm --readback rb_0002")).toBe("goldens confirm");
    expect(semlayerCommand("cat semantic/semantic.yaml")).toBeUndefined();
  });

  test("finds semlayer after a pipe, &&, ;, an env assignment or global flags, and not in a heredoc body", () => {
    expect(semlayerCommand("cat <<EOF | semlayer apply --file -\n{}\nEOF")).toBe("apply");
    expect(semlayerCommand("printf x | semlayer question resolve --answers -")).toBe("question resolve");
    expect(semlayerCommand("SEMLAYER_ENV_FILE=.env semlayer apply --file x")).toBe("apply");
    expect(semlayerCommand("cd /w && semlayer tag a pii")).toBe("tag");
    expect(semlayerCommand("true; semlayer set a b c")).toBe("set");
    expect(semlayerCommand("semlayer --root semantic apply --file -")).toBe("apply");
    expect(semlayerCommand(`${SEMLAYER} --json --env-file=.env question add x --text q`)).toBe("question add");
    expect(semlayerCommand("cat <<EOF > notes.txt\nsemlayer apply --file -\nEOF")).toBeUndefined();
    const e = (text: string): Entry => ({ n: "0001", ...run(text) });
    expect(answerCommands(e("semlayer apply --file a.json && semlayer question resolve --answers b.json"))).toEqual(["apply", "question resolve"]);
    expect(answerCommands(e("semlayer goldens new --name revenue_2025 --question q"))).toEqual(["goldens new"]);
    expect(recordsAnswers(e("semlayer question resolve --answers - <<A\nthe owner said --help is fine\nA"))).toBe(true);
  });

  test("counts an owner turn's commands as the successful ones that record answers, and the other exit conditions", () => {
    const dir = tempDir("walk-log");
    let n = 0;
    write(dir, ++n, { kind: "read", text: "/plugin/skills/semantic-layer/SKILL.md", exit: 0, bytes: 15000, refused: false, changed_layer: false });
    write(dir, ++n, run("semlayer next --json"), '{"kind":"ask_owner"}');
    write(dir, ++n, { kind: "owner", text: "What is one order?", exit: 0, bytes: 20, refused: false, changed_layer: false });
    write(dir, ++n, run(`${SEMLAYER} apply --file - <<'EDITS'\n{"edits": []}\nEDITS`, 0, { changed_layer: true }));
    write(dir, ++n, run(`${SEMLAYER} approve --help`));
    write(dir, ++n, run(`${SEMLAYER} question list | head -5`));
    write(dir, ++n, run("semlayer question resolve --answers -", 1), "Error: no such question");
    write(dir, ++n, run(`${SEMLAYER} readback --targets wh.orders`));
    write(dir, ++n, run(`${SEMLAYER} reply --readback rb_0001 --answers -`));
    write(dir, ++n, { kind: "read", text: "/walk/work/.env", exit: 2, bytes: 0, refused: true, changed_layer: false });
    write(dir, ++n, run("python3 edit.py", 0, { changed_layer: true, undone: true }));
    write(dir, ++n, { kind: "read", text: "/plugin/skills/semantic-layer/references/interview-guide.md", exit: 0, bytes: 20 * 1024, refused: false, changed_layer: false });
    write(dir, ++n, { kind: "owner", text: "Who may see emails?", exit: 0, bytes: 20, refused: false, changed_layer: false });
    write(dir, ++n, run(`${SEMLAYER} setup --source wh --check`), `connected as postgres://ro:${SECRET}@db/acme`);
    write(dir, ++n, run(`${SEMLAYER} tag wh.customers.email pii`));
    const c = count(dir, SECRET);
    expect(c.commands_per_owner_turn).toEqual([2, 1]);
    expect(c.most_commands_for_one_owner_turn).toMatchObject({ turn: "0003", count: 2 });
    expect(c.most_commands_for_one_owner_turn!.commands[1]).toBe(`${SEMLAYER} reply --readback rb_0001 --answers -`);
    expect(c.owner_turns).toBe(2);
    expect(c.commands_that_failed).toEqual(["0007 [exit 1] semlayer question resolve --answers -"]);
    expect(c.refused_by_hook).toEqual(["0010 read: /walk/work/.env"]);
    expect(c.undone_by_hook).toEqual(["0011 python3 edit.py"]);
    expect(c.layer_changed_by_a_non_semlayer_command).toEqual(["0011 python3 edit.py"]);
    expect(c.reads_over_12_kb).toEqual([{ file: "references/interview-guide.md", kb: 20 }]);
    expect(c.read_spec_md).toBe(false);
    expect(c.secret_in_log).toEqual([`0014 run: ${SEMLAYER} setup --source wh --check`]);
    expect(c.secret_in_transcript).toBe("not checked");
    expect(c.semlayer_by_command).toMatchObject({ next: 1, apply: 1, approve: 1, "question list": 1, "question resolve": 1, readback: 1, reply: 1, setup: 1, tag: 1 });
  });

  // HR-15 exit condition 4: the one-command form of a readback turn is one command.
  test("a turn of semlayer apply, semlayer question resolve --answers and semlayer reply --answers --approve counts three", () => {
    const dir = tempDir("walk-log");
    let n = 0;
    write(dir, ++n, { kind: "owner", text: "Yes to all eight; refunds do not count; is tax in?", exit: 0, bytes: 50, refused: false, changed_layer: false });
    write(dir, ++n, run(`${SEMLAYER} reply --readback rb_0009 --answers - --approve <<'ANSWERS'\n{"by": "Dana", "answers": []}\nANSWERS`, 0, { changed_layer: true }));
    write(dir, ++n, run(`${SEMLAYER} question resolve --answers - <<'ANSWERS'\n{"by": "Dana", "answers": []}\nANSWERS`, 0, { changed_layer: true }));
    write(dir, ++n, run(`${SEMLAYER} apply --file - <<'EDITS'\n{"edits": [["question", "add", "wh.orders", "--text", "Is tax in?"]]}\nEDITS`, 0, { changed_layer: true }));
    const c = count(dir, SECRET);
    expect(c.commands_per_owner_turn).toEqual([3]);
    expect(answerCommands({ n: "0002", ...run(`${SEMLAYER} reply --readback rb_0009 --answers - --approve`) })).toEqual(["reply"]);
  });

  test("a --help call, a list, a readback, a failed, refused or undone command records no answer", () => {
    const yes = (text: string, extra: Partial<Entry> = {}) => recordsAnswers({ n: "0001", ...run(text), ...extra });
    for (const t of ["semlayer apply --file -", "semlayer set wh.orders grain x", "semlayer question add wh.orders --text q", "semlayer goldens confirm --readback rb_0003", `${SEMLAYER} add-join --source wh`])
      expect(yes(t), t).toBe(true);
    for (const t of ["semlayer apply --help", "semlayer tag -h", "semlayer question list", "semlayer question list | wc -l", "semlayer readback --targets x", "semlayer check-rule --source wh", "semlayer goldens check", "semlayer validate"])
      expect(yes(t), t).toBe(false);
    expect(yes("semlayer apply --file -", { exit: 1 })).toBe(false);
    expect(yes("semlayer reply --readback rb_0001 --answers -", { undone: true })).toBe(false);
  });
});

// w.sh needs bash and bun on PATH.
const hasShell = Bun.which("bash") !== null && Bun.which("bun") !== null;

describe("w.sh", () => {
  test.skipIf(!hasShell)("refuses a read of the project's .env after a semlayer command, and logs the refusal", () => {
    const walk = realpathSync(tempDir("walk"));
    mkdirSync(join(walk, "work"));
    writeFileSync(join(walk, "work", ".env"), `WAREHOUSE_URL=postgresql://reader:${SECRET}@localhost/acme\n`);
    const env = { ...process.env, WALK: walk, PLUGIN: REPO };
    const w = (...args: string[]) => Bun.spawnSync(["bash", join(REPO, "evals", "walkthrough", "w.sh"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const first = w("run", `bun ${join(REPO, "skills", "semantic-layer", "scripts", "semlayer.ts")} next`);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain("semlayer init --name <name>");
    const read = w("read", ".env");
    expect(read.exitCode).toBe(2);
    expect(read.stdout.toString()).toContain("refused Read");
    const log = join(walk, "log");
    expect(JSON.parse(readFileSync(join(log, "0002.json"), "utf8"))).toMatchObject({ kind: "read", exit: 2, refused: true });
    expect(readFileSync(join(log, "0002.out"), "utf8")).toContain("refused Read");
    const c = count(log, SECRET);
    expect(c.refused_by_hook).toEqual([`0002 read: ${join(walk, "work", ".env")}`]);
    expect(c.secret_in_log).toEqual([]);
    expect(c.semlayer_by_command).toEqual({ next: 1 });
  }, 60_000);
});
