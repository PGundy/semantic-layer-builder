import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readYaml } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import type { Project } from "../skills/semantic-layer/scripts/lib/types.ts";
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

  test("init writes the settings explicitly, so the owner can see and change them", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["init", "--name", "acme", "--default-source", "wh", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json<{ project: Project }>().project.settings).toEqual({ focus_threshold: 12, batch_size: 5 });
    const project = readYaml<Project>(join(t.root, "semantic.yaml"));
    expect(project).toEqual({ version: 1, name: "acme", default_source: "wh", settings: { focus_threshold: 12, batch_size: 5 } });
    expect(readFileSync(join(t.root, "semantic.yaml"), "utf8")).toContain("settings:\n  focus_threshold: 12\n  batch_size: 5\n");
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
