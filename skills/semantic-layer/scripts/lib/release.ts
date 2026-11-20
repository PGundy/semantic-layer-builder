// The changelog of a layer, changelog.yaml beside semantic.yaml (spec: Iterating a layer, The
// changelog). It is append-only: appendEntry adds an entry with a version above the last, and nothing
// here edits or removes one. Commands that call appendEntry hold the root's lock for their run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { UserError } from "./errors.ts";
import type { Changelog, ChangelogEntry } from "./release-types.ts";
import { SCHEMAS_DIR } from "./schema.ts";
import { parseYamlText, writeYaml } from "./yaml.ts";

export const CHANGELOG_FILE = "changelog.yaml";
export const VERSION_PATTERN = /^(\d+)\.(\d+)$/;

let validator: ValidateFunction | undefined;

function check(data: unknown): string | null {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
    ajv.addFormat("date", { type: "string", validate: (s: string) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s) });
    validator = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS_DIR, "changelog.schema.json"), "utf8")) as object);
  }
  if (validator(data)) return null;
  const e = validator.errors?.[0];
  return `${e?.instancePath || "the file"} ${e?.message ?? "does not match schemas/changelog.schema.json"}`;
}

// 1.10 is above 1.9: each part is compared as a number. Negative when a is below b.
export function compareVersions(a: string, b: string): number {
  const [am, an] = a.split(".").map(Number) as [number, number];
  const [bm, bn] = b.split(".").map(Number) as [number, number];
  return am - bm || an - bn;
}

// The changelog and the reason it cannot be read, from one parse. `log` is null when there is no
// file or it does not read; `problem` is null when it reads (or there is none). A changelog whose
// versions do not rise is malformed too.
export function loadChangelog(root: string): { log: Changelog | null; problem: string | null } {
  const file = join(root, CHANGELOG_FILE);
  if (!existsSync(file)) return { log: null, problem: null };
  let data: unknown;
  try {
    data = parseYamlText(readFileSync(file, "utf8"), CHANGELOG_FILE);
  } catch (e) {
    return { log: null, problem: (e as Error).message };
  }
  const problem = check(data);
  if (problem) return { log: null, problem };
  const entries = (data as Changelog).entries;
  for (let i = 1; i < entries.length; i++) {
    if (compareVersions(entries[i]!.version, entries[i - 1]!.version) <= 0)
      return { log: null, problem: `/entries/${i}/version ${entries[i]!.version} does not rise above ${entries[i - 1]!.version}` };
  }
  return { log: data as Changelog, problem: null };
}

// The changelog, or null when the layer has none. A file that does not read as one is refused in a
// line naming it and the problem.
export function readChangelog(root: string): Changelog | null {
  const { log, problem } = loadChangelog(root);
  if (problem) throw new UserError(`${CHANGELOG_FILE} is malformed: ${problem}. Restore it from version control; the file is append-only and semlayer change close adds to it.`, "semlayer validate");
  return log;
}

// Adds an entry at the end. A version not above the last entry's, or an entry that does not match
// the schema, is refused and nothing is written; the file is replaced whole (temp file and rename).
export function appendEntry(root: string, entry: ChangelogEntry): void {
  const log = readChangelog(root) ?? { version: 1 as const, entries: [] };
  if (!VERSION_PATTERN.test(entry.version)) throw new UserError(`"${entry.version}" is not a layer version. Write it as major.minor, such as 1.1.`);
  const last = log.entries.at(-1);
  if (last && compareVersions(entry.version, last.version) <= 0)
    throw new UserError(`Version ${entry.version} is not above the last release, ${last.version}. Choose a higher version, such as ${last.version.split(".")[0]}.${Number(last.version.split(".")[1]) + 1}.`);
  const next = { version: 1, entries: [...log.entries, entry] };
  const problem = check(next);
  if (problem) throw new UserError(`The changelog entry is not valid: ${problem}.`);
  writeYaml(join(root, CHANGELOG_FILE), next);
}
