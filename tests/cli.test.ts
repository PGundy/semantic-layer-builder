import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { duckdbSource, initProject, sl, tempRoot } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("cli", () => {
  test("init writes the project and layout", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root, "acme");
    expect(existsSync(join(t.root, "semantic.yaml"))).toBe(true);
    expect(existsSync(join(t.root, "models"))).toBe(true);
    const again = await sl(t.root, ["init", "--name", "acme"]);
    expect(again.code).toBe(1);
  });

  test("run executes a read-only query and refuses writes", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders as select range as id, range * 2 as amount from range(5)"]);
    const ok = await sl(t.root, ["run", "--source", "wh", "--sql", "select count(*) as n, sum(amount) as total from orders", "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json<{ rows: unknown[] }>().rows).toEqual([{ n: 5, total: 20 }]);
    const bad = await sl(t.root, ["run", "--source", "wh", "--sql", "drop table orders"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("read-only");
  });

  test("unknown command fails cleanly", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["nope"]);
    expect(r.code).toBe(1);
  });
});
