import { expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "compat-pg.sh");
const run = (...args: string[]) => Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

test("compat-pg.sh asks for one major version number before it touches Docker", () => {
  for (const args of [[], ["14", "15"], ["14.1"], ["latest"]]) {
    const r = run(...args);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/^compat-pg: /);
  }
  expect(run("latest").stderr.toString()).toContain("major number");
});
