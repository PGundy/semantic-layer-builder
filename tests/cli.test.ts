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

  test("run --limit takes a positive integer, defaults to 100 and counts every row", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table orders as select range as id from range(150)"]);
    const all = await sl(t.root, ["run", "--source", "wh", "--sql", "select id from orders order by id", "--json"]);
    expect(all.code).toBe(0);
    const out = all.json<{ rows: unknown[]; row_count: number; truncated: boolean }>();
    expect(out.rows).toHaveLength(100);
    expect(out.row_count).toBe(150);
    expect(out.truncated).toBe(true);
    const two = await sl(t.root, ["run", "--source", "wh", "--sql", "select id from orders order by id", "--limit", "2"]);
    expect(two.code).toBe(0);
    expect(two.out).toContain("(150 rows, showing 2)");
    for (const bad of ["abc", "0", "-3", "2.5", "", "1e3"]) {
      const r = await sl(t.root, ["run", "--source", "wh", "--sql", "select 1", `--limit=${bad}`]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--limit must be a positive integer");
      expect(r.out).toBe("");
    }
    const help = await sl(t.root, ["run", "--help"]);
    expect(help.out).toContain("--limit defaults to 100; all rows are counted, at most n are shown");
    expect(help.out).toContain("[--show-protected]");
    expect(help.out).toContain("values of protected columns show as [protected] unless --show-protected");
  });

  test("run masks a column named like personal data, refuses duplicate names and strips escapes", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    await duckdbSource(t.root, t.dir, "wh", ["create table people as select 1 as id, 'ana@example.com' as email, 'Lisbon' as city"]);
    const r = await sl(t.root, ["run", "--source", "wh", "--sql", "select id, email, city from people"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("id  email        city\n--  -----------  ------\n1   [protected]  Lisbon\n(1 row)\nProtected column shown as [protected]: email.");
    const shown = await sl(t.root, ["run", "--source", "wh", "--sql", "select email from people", "--show-protected"]);
    expect(shown.out).toContain("ana@example.com");
    expect(shown.out).not.toContain("Protected column");
    const dupes = await sl(t.root, ["run", "--source", "wh", "--sql", "select id, city as id from people"]);
    expect(dupes.code).toBe(1);
    expect(dupes.err).toBe('sl run: The result has more than one column named "id"; alias them so each column has its own name.');
    const ansi = await sl(t.root, ["run", "--source", "wh", "--sql", "select chr(27) || ']0;owned' || chr(7) || chr(27) || '[2Jok' as s"]);
    expect(ansi.out).toBe("s\n--\nok\n(1 row)");
  });

  test("every command's --help names the global flags", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    for (const command of ["run", "status", "goldens", "check-join", "init"]) {
      const r = await sl(t.root, [command, "--help"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Usage: sl ");
      expect(r.out).toEndWith("\n\nEvery command also takes --root <dir> (or SEMANTIC_ROOT), --env-file <path> (or SL_ENV_FILE) and --json.");
    }
  });

  test("sl help names the global flags", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["help"]);
    expect(r.out).toStartWith("Usage: sl <command> [flags]\nEvery command also takes --root <dir> (or SEMANTIC_ROOT), --env-file <path> (or SL_ENV_FILE) and --json.\n");
  });

  test("unknown command fails cleanly", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    const r = await sl(t.root, ["nope"]);
    expect(r.code).toBe(1);
  });
});
