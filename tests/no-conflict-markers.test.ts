// No tracked file holds a merge conflict marker. A merge that stops on a conflict leaves
// "<<<<<<< ours" and ">>>>>>> theirs" lines in the file; committing them breaks the text they sit in
// without failing any other check.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MARKER = /^(<{7}|>{7}) \S/;

function trackedFiles(): string[] | null {
  const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().split("\0").filter(Boolean);
}

describe("merge conflict markers", () => {
  const files = trackedFiles();

  test.skipIf(files === null)("no tracked text file holds one", () => {
    const found: string[] = [];
    for (const file of files!) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), "utf8");
      } catch {
        continue; // deleted in the working tree
      }
      if (text.includes("\0")) continue; // not text
      text.split("\n").forEach((line, i) => {
        if (MARKER.test(line)) found.push(`${file}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("the pattern matches the lines git writes and not a rule of equals signs", () => {
    expect(MARKER.test("<<<<<<< HEAD")).toBe(true);
    expect(MARKER.test(">>>>>>> origin/release/v1")).toBe(true);
    expect(MARKER.test("=======")).toBe(false);
    expect(MARKER.test("  <<<<<<< HEAD")).toBe(false);
  });
});
