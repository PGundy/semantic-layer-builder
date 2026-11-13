import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every temp directory a test makes comes from tempDir. bunfig.toml preloads this file, so the
// hooks at the bottom are the run's own: a file's directories are removed when the next file's
// first test starts, the last file's when the run ends, and whatever is left when a test exits the
// process or a signal stops it. scripts/verify.sh fails when a run leaves an sl-test-* entry behind.

// Each directory and the test file that made it. Bun.main names the file being loaded or run.
const made = new Map<string, string>();

// A fresh directory under the system temp directory, named sl-test-<label>-<random>.
export function tempDir(label = ""): string {
  const dir = mkdtempSync(join(tmpdir(), label ? `sl-test-${label}-` : "sl-test-"));
  made.set(dir, Bun.main);
  return dir;
}

// Removes every directory tempDir made, except those of the test file `keep`. A directory that
// cannot be removed is left for verify.sh to name.
export function removeTempDirs(keep?: string): void {
  for (const [dir, file] of made) {
    if (file === keep) continue;
    made.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

beforeEach(() => removeTempDirs(Bun.main));
afterAll(() => removeTempDirs());
// bun test emits no exit event when it finishes; it does when a test calls process.exit, and a
// signal is turned into one here.
process.on("exit", () => removeTempDirs());
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) process.on(signal, () => process.exit(code));
