// The examples/acme goldens hold their hand-written query under cross_check_sql (FR-2.2): sl validate
// gives the example no warning about the older key sql, the rename leaves every golden's content
// hash as it was, so an owner's yes recorded before it still matches after it. All data is the
// synthetic Acme fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goldenHash } from "../skills/semantic-layer/scripts/lib/approval-hash.ts";
import { DEFAULT_TOLERANCE } from "../skills/semantic-layer/scripts/lib/goldens.ts";
import type { Golden } from "../skills/semantic-layer/scripts/lib/types.ts";
import { unconfirmedGoldenMessage, validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { sl, tempRoot } from "./helpers.ts";

const REPO = join(import.meta.dir, "..");
const ACME = join(REPO, "examples", "acme", "semantic");
const GOLDENS = join(ACME, "goldens");
const FILES = readdirSync(GOLDENS).filter((f) => f.endsWith(".yaml")).sort();

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// A golden file as it was before the rename: the same text with the key cross_check_sql named sql.
const beforeRename = (text: string) => text.replace(/^cross_check_sql:/m, "sql:");

const parse = (text: string) => parseYamlText(text) as Golden;
const hashOf = (g: Golden) => goldenHash(g as unknown as Record<string, unknown>, g.expected?.rows ?? [], g.expected?.tolerance ?? DEFAULT_TOLERANCE);

describe("examples/acme goldens use cross_check_sql", () => {
  test("every golden has cross_check_sql and no key sql, and sl validate gives the example no error and no alias warning", () => {
    expect(FILES.length).toBe(17);
    for (const f of FILES) {
      const text = readFileSync(join(GOLDENS, f), "utf8");
      const g = parse(text);
      expect({ f, cross: typeof g.cross_check_sql, sql: g.sql }).toEqual({ f, cross: "string", sql: undefined });
      expect({ f, lines: text.split("\n").filter((l) => /^(sql|cross_check_sql):/.test(l)) }).toEqual({ f, lines: ["cross_check_sql: |"] });
    }
    const issues = validateProject(ACME);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.filter((i) => i.path === "sql" || i.message.includes("is now cross_check_sql"))).toEqual([]);
    // Beyond the confirmations made before sl goldens confirm required a recorded yes, the goldens'
    // only warning is the draft golden that names a measure engineering has not added yet.
    const goldenIssues = issues.filter((i) => i.file.startsWith("goldens/") && !i.message.startsWith("golden:"));
    expect(goldenIssues.map((i) => [i.level, i.file, i.path])).toEqual([["warning", "goldens/new_customers_2025.yaml", "request.measures[0]"]]);
  });

  test("the rename leaves every golden's content hash as it was", () => {
    for (const f of FILES) {
      const text = readFileSync(join(GOLDENS, f), "utf8");
      const now = parse(text);
      const before = parse(beforeRename(text));
      expect(before.sql).toBe(now.cross_check_sql);
      expect({ f, hash: hashOf(before) }).toEqual({ f, hash: hashOf(now) });
    }
  });

  test("an owner's yes recorded before the rename still matches the golden after it", async () => {
    const t = tempRoot();
    cleanups.push(t.cleanup);
    cpSync(ACME, t.root, { recursive: true });
    // The copy's lake views read the fixture by absolute path.
    const lake = join(t.root, "sources", "lake.yaml");
    writeFileSync(lake, readFileSync(lake, "utf8").replaceAll("'../../../fixtures/", `'${join(REPO, "fixtures")}/`));
    const path = join(t.root, "goldens", "sessions_2025.yaml");
    const committed = readFileSync(path, "utf8");
    writeFileSync(path, beforeRename(committed));
    const unconfirmed = () => validateProject(t.root).filter((i) => i.file === "goldens/sessions_2025.yaml" && i.message === unconfirmedGoldenMessage("sessions_2025"));
    expect(unconfirmed().length).toBe(1);

    const rb = await sl(t.root, ["readback", "--targets", "golden:sessions_2025", "--tolerance", "0", "--json"]);
    expect(rb.code).toBe(0);
    const id = rb.json<{ readback_id: string }>().readback_id;
    const reply = await sl(t.root, ["reply", "--readback", id, "--item", "1", "--text", "Yes, 4,551 sessions.", "--verdict", "yes", "--by", "Dana Ruiz"]);
    expect(reply.code).toBe(0);
    expect(unconfirmed()).toEqual([]);

    writeFileSync(path, committed);
    expect(validateProject(t.root).filter((i) => i.file === "goldens/sessions_2025.yaml")).toEqual([]);
    const confirm = await sl(t.root, ["goldens", "confirm", "--name", "sessions_2025", "--by", "Dana Ruiz", "--tolerance", "0"]);
    expect(confirm.code).toBe(0);
  });
});
