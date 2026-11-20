// The registry of issue codes. Every other .ts file in this directory is a family file whose default
// export maps each code to its usual level, a one-line meaning and, where one exists, the next
// command. The files load once, in sorted file order, on first use, so adding a family is adding a
// file, with no edit here. A code is added or retired, never renamed or reused.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface CodeInfo {
  level: "error" | "warning";
  meaning: string;
  next?: string;
}

export type CodeFamily = Readonly<Record<string, CodeInfo>>;

export interface RegisteredCode extends CodeInfo {
  // The family file that registers the code.
  file: string;
}

// A code is a lowercase family and a lowercase name joined by one dot: schema.required.
export const CODE_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;

// The code of a layer check that has none of its own yet.
export const UNCLASSIFIED = "issue.unclassified";

function familyFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
}

// The codes the family files of a directory register. A malformed or repeated code, or a family
// file without a map as its default export, is a mistake in this repository, so it throws naming
// the file.
export function loadCodes(dir: string): Map<string, RegisteredCode> {
  const load = createRequire(join(dir, "index.ts"));
  const out = new Map<string, RegisteredCode>();
  for (const file of familyFiles(dir)) {
    const family = (load(join(dir, file)) as { default?: unknown }).default;
    if (!family || typeof family !== "object" || Array.isArray(family)) throw new Error(`${join(dir, file)} has no default export map of codes`);
    for (const [code, info] of Object.entries(family as Record<string, unknown>)) {
      const where = `${join(dir, file)}: ${code}`;
      if (!CODE_PATTERN.test(code)) throw new Error(`${where} is not a code; write family.name in lowercase letters, digits and underscores`);
      const prior = out.get(code);
      if (prior) throw new Error(`${where} is already registered in ${prior.file}`);
      const i = info as Partial<CodeInfo> | null;
      if (!i || (i.level !== "error" && i.level !== "warning")) throw new Error(`${where} needs level error or warning`);
      if (typeof i.meaning !== "string" || !i.meaning.trim() || i.meaning.includes("\n")) throw new Error(`${where} needs a meaning of one line`);
      if (i.next !== undefined && (typeof i.next !== "string" || !i.next.trim())) throw new Error(`${where} has a next that is not a command`);
      out.set(code, { level: i.level, meaning: i.meaning, ...(i.next !== undefined ? { next: i.next } : {}), file });
    }
  }
  return out;
}

let cached: Map<string, RegisteredCode> | undefined;

// Every registered code, by code.
export function issueCodes(): ReadonlyMap<string, RegisteredCode> {
  cached ??= loadCodes(import.meta.dir);
  return cached;
}

export function isRegistered(code: string): boolean {
  return issueCodes().has(code);
}
