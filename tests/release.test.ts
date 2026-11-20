import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolUse } from "../skills/semantic-layer/scripts/hooks/guard-edits.ts";
import { appendEntry, compareVersions, readChangelog } from "../skills/semantic-layer/scripts/lib/release.ts";
import type { ChangelogEntry } from "../skills/semantic-layer/scripts/lib/release-types.ts";
import { loadCodes } from "../skills/semantic-layer/scripts/lib/issue-codes/index.ts";
import { validateProject } from "../skills/semantic-layer/scripts/lib/validate.ts";
import { releaseFixture } from "./release-fixture.ts";
import { semlayer } from "./helpers.ts";

// Layer version and changelog (spec: Iterating a layer, Layer version and changelog).

const entry = (version: string, over: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
  version,
  date: "2026-02-03",
  note: "A release.",
  items: { "warehouse.orders.revenue": `sha256:${"a".repeat(64)}` },
  goldens: { revenue_by_month: [{ month: "2025-01", revenue: 1200 }] },
  added: [],
  changed: [],
  removed: [],
  goldens_moved: [],
  ...over,
});

const codesOf = (root: string) => validateProject(root).filter((i) => i.code.startsWith("release.")).map((i) => `${i.code} ${i.file}`);

describe("appendEntry", () => {
  test("refuses 1.0 after 1.1, and 1.1 twice, and writes nothing", () => {
    const root = releaseFixture();
    appendEntry(root, entry("1.1"));
    const before = readFileSync(join(root, "changelog.yaml"), "utf8");
    expect(() => appendEntry(root, entry("1.0"))).toThrow(/not above the last release, 1\.1/);
    expect(() => appendEntry(root, entry("1.1"))).toThrow(/not above/);
    expect(readFileSync(join(root, "changelog.yaml"), "utf8")).toBe(before);
  });

  test("compares parts as numbers: 1.10 is above 1.9", () => {
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    const root = releaseFixture();
    appendEntry(root, entry("1.9"));
    appendEntry(root, entry("1.10"));
    expect(readChangelog(root)!.entries.map((e) => e.version)).toEqual(["1.9", "1.10"]);
  });

  test("creates the file, keeps earlier entries and leaves no temporary file", () => {
    const root = releaseFixture();
    expect(readChangelog(root)).toBeNull();
    appendEntry(root, entry("1.0"));
    appendEntry(root, entry("1.1", { added: ["metric:refund_rate"] }));
    const log = readChangelog(root)!;
    expect(log.entries.map((e) => e.version)).toEqual(["1.0", "1.1"]);
    expect(log.entries[1]!.added).toEqual(["metric:refund_rate"]);
    expect(existsSync(join(root, ".changelog.yaml.semlayer-tmp"))).toBe(false);
  });

  test("refuses a version that is not major.minor, and an entry that breaks the schema", () => {
    const root = releaseFixture();
    expect(() => appendEntry(root, entry("1"))).toThrow(/major\.minor/);
    expect(() => appendEntry(root, entry("1.0", { date: "yesterday" }))).toThrow(/not valid/);
    expect(existsSync(join(root, "changelog.yaml"))).toBe(false);
  });
});

describe("validate", () => {
  test("a layer that has never been released has no release message", () => {
    expect(codesOf(releaseFixture())).toEqual([]);
  });

  test("a malformed changelog fails with the file name and code", () => {
    const root = releaseFixture();
    writeFileSync(join(root, "changelog.yaml"), "version: 1\nentries:\n  - version: one\n");
    expect(codesOf(root)).toEqual(["release.changelog_malformed changelog.yaml"]);
    writeFileSync(join(root, "changelog.yaml"), "entries: [unclosed\n");
    expect(codesOf(root)).toEqual(["release.changelog_malformed changelog.yaml"]);
    expect(() => readChangelog(root)).toThrow(/changelog\.yaml is malformed/);
  });

  test("versions that do not rise are malformed", () => {
    const root = releaseFixture();
    appendEntry(root, entry("1.1"));
    const text = readFileSync(join(root, "changelog.yaml"), "utf8");
    const second = text.split("\n").slice(2).join("\n");
    writeFileSync(join(root, "changelog.yaml"), text + second);
    expect(codesOf(root)).toEqual(["release.changelog_malformed changelog.yaml"]);
  });

  test("layer_version different from the last entry fails", async () => {
    const root = releaseFixture();
    appendEntry(root, entry("1.1"));
    expect(codesOf(root)).toEqual(["release.version_mismatch semantic.yaml"]);
    const semantic = join(root, "semantic.yaml");
    writeFileSync(semantic, `${readFileSync(semantic, "utf8")}layer_version: "1.0"\n`);
    expect(codesOf(root)).toEqual(["release.version_mismatch semantic.yaml"]);
    writeFileSync(semantic, readFileSync(semantic, "utf8").replace('layer_version: "1.0"', 'layer_version: "1.1"'));
    expect(codesOf(root)).toEqual([]);
  });

  test("layer_version with no changelog fails, and a malformed layer_version fails the schema", () => {
    const root = releaseFixture();
    const semantic = join(root, "semantic.yaml");
    writeFileSync(semantic, `${readFileSync(semantic, "utf8")}layer_version: "1.0"\n`);
    expect(codesOf(root)).toEqual(["release.version_mismatch semantic.yaml"]);
    writeFileSync(semantic, readFileSync(semantic, "utf8").replace('"1.0"', '"v1"'));
    expect(validateProject(root).some((i) => i.file === "semantic.yaml" && i.level === "error")).toBe(true);
  });

  test("the CLI prints the code on a malformed changelog", async () => {
    const root = releaseFixture();
    writeFileSync(join(root, "changelog.yaml"), "nope: 1\n");
    const r = await semlayer(root, ["validate", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("release.changelog_malformed");
  });

  test("the two codes are registered", () => {
    const codes = loadCodes(join(import.meta.dir, "..", "skills", "semantic-layer", "scripts", "lib", "issue-codes"));
    expect(codes.get("release.changelog_malformed")?.level).toBe("error");
    expect(codes.get("release.version_mismatch")?.level).toBe("error");
    expect(codes.get("release.column_retyped")?.level).toBe("warning");
  });
});

describe("the hook guards changelog.yaml like the ledger", () => {
  const run = (tool: string, input: Record<string, unknown>, cwd: string) => checkToolUse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd }));

  test("Write, Edit and shell writes are refused, with the reason", () => {
    const root = releaseFixture();
    appendEntry(root, entry("1.0"));
    const file = join(root, "changelog.yaml");
    for (const v of [
      run("Write", { file_path: file, content: "version: 1\nentries: []\n" }, root),
      run("Edit", { file_path: file, old_string: "A release.", new_string: "Changed." }, root),
      run("Bash", { command: `echo x >> ${file}` }, root),
      run("Bash", { command: "sed -i s/a/b/ changelog.yaml" }, root),
      run("Bash", { command: "rm changelog.yaml" }, root),
    ]) {
      expect(v.allow).toBe(false);
      expect(v.message).toContain("changelog.yaml");
      expect(v.message).toContain("semlayer change close");
    }
  });

  test("a new changelog is refused too, and reading it is allowed", () => {
    const root = releaseFixture();
    const file = join(root, "changelog.yaml");
    expect(run("Write", { file_path: file, content: "version: 1\nentries: []\n" }, root).allow).toBe(false);
    expect(run("Bash", { command: `cat ${file}` }, root).allow).toBe(true);
  });
});
