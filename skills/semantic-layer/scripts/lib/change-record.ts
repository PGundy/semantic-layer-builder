// The open change round, .semlayer/change.json under the semantic root (spec: Iterating a layer, The
// change round). semlayer change start writes it, semlayer change close removes it, and status reads it:
// while it exists a finished layer is in phase `change`. It holds the owner's note, who asked, when
// (the command's clock) and the version the round started from; never a data value or a connection detail.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { UserError } from "./errors.ts";
import { writeFileAtomic } from "./lock.ts";
import { loadChangelog } from "./release.ts";
import { SCHEMAS_DIR } from "./schema.ts";

export const CHANGE_FILE = ".semlayer/change.json";

export interface ChangeRecord {
  version: 1;
  note: string;
  started_by: string;
  started_at: string;
  from_version: string;
  // The drafts never approved that were present when the round started (refs, sorted): the owner's deferred ones.
  // A round written without it counts none as deferred.
  drafts_at_start?: string[];
}

let validator: ValidateFunction | undefined;

// The record and the reason it cannot be read, from one parse: `change` is null when there is no
// file or it does not read, `problem` is null when it reads (or there is none).
export function loadChange(root: string): { change: ChangeRecord | null; problem: string | null } {
  const file = join(root, CHANGE_FILE);
  if (!existsSync(file)) return { change: null, problem: null };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { change: null, problem: "it is not valid JSON" };
  }
  validator ??= new Ajv2020({ allErrors: true, strictTypes: false }).compile(JSON.parse(readFileSync(join(SCHEMAS_DIR, "change.schema.json"), "utf8")) as object);
  if (!validator(data)) {
    const e = validator.errors?.[0];
    return { change: null, problem: `${e?.instancePath || "the file"} ${e?.message ?? "does not match schemas/change.schema.json"}` };
  }
  return { change: data as ChangeRecord, problem: null };
}

// The open change round, or null. A file that does not read is refused in a line naming it.
export function readChange(root: string): ChangeRecord | null {
  const { change, problem } = loadChange(root);
  if (problem)
    throw new UserError(
      `${CHANGE_FILE} is malformed: ${problem}. Delete the file to leave the round, or restore it from version control; semlayer validate names the problem.`,
      "semlayer validate",
      "release.change_malformed",
    );
  return change;
}

// .semlayer may be a link to a directory inside the root; one that leads outside it or nowhere is refused.
function assertInside(root: string): void {
  const dir = join(root, ".semlayer");
  if (!lstatSync(dir, { throwIfNoEntry: false })) return;
  const why = `Refusing to write ${CHANGE_FILE}: .semlayer`;
  const fix = "Nothing was written. Replace the link with a directory inside the semantic root and run the command again.";
  if (!existsSync(dir)) throw new UserError(`${why} is a symbolic link to nothing. ${fix}`);
  const r = realpathSync(root);
  const p = realpathSync(dir);
  if (p !== r && !p.startsWith(r + sep)) throw new UserError(`${why} resolves outside the semantic root ${resolve(root)}. ${fix}`);
}

// Writes the record whole (temp file and rename). Called under the root's lock.
export function writeChange(root: string, record: ChangeRecord): void {
  assertInside(root);
  const file = join(root, CHANGE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
}

// Removes the record, when there is one: semlayer change close does, as the last write of a close. Called under the root's lock.
export function removeChange(root: string): void {
  assertInside(root);
  const file = join(root, CHANGE_FILE);
  if (existsSync(file)) unlinkSync(file);
}

// The sentence a finished layer's next step ends with (spec: Iterating a layer, The change round). A layer
// is released first and changed after: with no release yet it names the first release, and once released
// it names how to open a change round. A changelog that does not read gets none; semlayer validate names it.
export function releaseLead(root: string): string {
  const { log, problem } = loadChangelog(root);
  if (problem) return "";
  const last = log?.entries.at(-1);
  if (!last)
    return (
      "The layer has no release yet: once the owner agrees it is finished, record it as release 1.0 with semlayer change close --version 1.0, " +
      "which saves the items and the golden figures as they stand so later changes can be compared with them."
    );
  return (
    `To change this finished layer (one more metric, table or definition), start a change round with semlayer change start --note "<what the owner wants changed>" --by "<owner>"; ` +
    `semlayer change status then shows what moved since release ${last.version}.`
  );
}
