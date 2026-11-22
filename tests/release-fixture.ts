import { cpSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const ACME = join(import.meta.dir, "..", "examples", "acme", "semantic");

// A copy of the finished example layer (examples/acme/semantic) in a temp directory, for the tests of
// layer versions, changelogs and change rounds. The directory is removed when the test file ends.
export function releaseFixture(): string {
  const root = join(tempDir("release"), "semantic");
  cpSync(ACME, root, { recursive: true });
  return root;
}
