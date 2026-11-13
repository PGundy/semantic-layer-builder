import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { tempDir, tempRoot } from "./helpers.ts";

// Temp directories (docs/PRD-hardening.md HR-1): tempDir and tempRoot make them, and
// tests/temp-dirs.ts, preloaded by bunfig.toml, removes them when their test file finishes, pass or
// fail, and when the process exits early.

const REPO = join(import.meta.dir, "..");
const IMPORT = `import { tempDir, tempRoot } from ${JSON.stringify(join(import.meta.dir, "helpers.ts"))};`;

// Writes throwaway test files and returns the command that runs them from the repository root with
// a temp directory of their own, and a function that lists the sl-test-* entries left in it.
function nested(files: Record<string, string>): { cmd: string[]; env: Record<string, string | undefined>; dir: string; left: () => string[] } {
  const dir = tempDir("nested");
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const paths = Object.entries(files).map(([name, body]) => {
    writeFileSync(join(dir, name), `${IMPORT}\n${body}`);
    return join(dir, name);
  });
  return { cmd: ["bun", "test", ...paths], env: { ...process.env, TMPDIR: tmp }, dir, left: () => readdirSync(tmp).filter((n) => n.startsWith("sl-test-")) };
}

describe("tempDir and tempRoot", () => {
  test("make a directory named sl-test-* directly under the system temp directory", () => {
    const plain = tempDir();
    const labelled = tempDir("label");
    const { dir, root } = tempRoot();
    for (const d of [plain, labelled, dir]) {
      expect(statSync(d).isDirectory()).toBe(true);
      expect(dirname(d)).toBe(tmpdir());
      expect(basename(d)).toStartWith("sl-test-");
    }
    expect(basename(labelled)).toStartWith("sl-test-label-");
    expect(root).toBe(join(dir, "semantic"));
  });

  test("a test file's directories last until its last test and are gone when the next file runs, pass or fail", () => {
    const run = nested({
      "a-first.test.ts": `
        import { beforeAll, expect, test } from "bun:test";
        import { existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const atLoad = tempDir("load");
        let inHook = "";
        let inTest = "";
        beforeAll(() => {
          inHook = tempDir("hook");
        });
        test("a directory made in a test", () => {
          inTest = tempRoot().dir;
          writeFileSync(join(inTest, "file"), "x");
        });
        test("a failing test", () => {
          tempDir("failing");
          expect(1).toBe(2);
        });
        test("every directory is still there in the file's last test", () => {
          for (const d of [atLoad, inHook, inTest]) expect(existsSync(d)).toBe(true);
        });`,
      "b-second.test.ts": `
        import { expect, test } from "bun:test";
        import { readdirSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { basename } from "node:path";
        const mine = tempDir("second");
        test("only this file's directory is left", () => {
          expect(readdirSync(tmpdir()).filter((n) => n.startsWith("sl-test-"))).toEqual([basename(mine)]);
        });`,
    });
    const r = Bun.spawnSync(run.cmd, { cwd: REPO, env: run.env, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).toContain(" 3 pass");
    expect(out).toContain(" 1 fail");
    expect(r.exitCode).toBe(1);
    expect(run.left()).toEqual([]);
  }, 60_000);

  test("a run that exits inside a test leaves nothing", () => {
    const run = nested({
      "exits.test.ts": `
        import { test } from "bun:test";
        test("exits", () => {
          tempDir("exits");
          process.exit(3);
        });`,
    });
    const r = Bun.spawnSync(run.cmd, { cwd: REPO, env: run.env, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(3);
    expect(run.left()).toEqual([]);
  }, 60_000);

  test("a run that is stopped by a signal leaves nothing", async () => {
    const run = nested({
      "waits.test.ts": `
        import { test } from "bun:test";
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        test("waits", async () => {
          tempDir("waits");
          writeFileSync(join(import.meta.dir, "ready"), "");
          await Bun.sleep(60_000);
        }, 70_000);`,
    });
    const proc = Bun.spawn(run.cmd, { cwd: REPO, env: run.env, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 300 && !existsSync(join(run.dir, "ready")); i++) await Bun.sleep(100);
    expect(run.left()).toHaveLength(1);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(run.left()).toEqual([]);
  }, 60_000);
});

describe("the tests and evals", () => {
  // A directory made any other way is neither removed nor counted by scripts/verify.sh.
  test("make their temp directories with tempDir only", () => {
    const made: string[] = [];
    for (const root of ["tests", "evals"]) {
      for (const f of new Bun.Glob("**/*.ts").scanSync(join(REPO, root))) {
        const file = join(REPO, root, f);
        if (file === join(import.meta.dir, "temp-dirs.ts")) continue;
        // evals/smoke.ts is the eval:smoke command, not a test: it removes its own directory.
        if (file === join(REPO, "evals", "smoke.ts")) continue;
        if (/mkdtemp\w*\([^\n]*tmpdir\(\)/.test(readFileSync(file, "utf8"))) made.push(relative(REPO, file));
      }
    }
    expect(made).toEqual([]);
  });

  test("are run with tests/temp-dirs.ts preloaded", () => {
    expect(readFileSync(join(REPO, "bunfig.toml"), "utf8")).toContain('preload = ["./tests/temp-dirs.ts"]');
  });
});
