// Scope patterns (spec: Scope patterns). Globs with * and ?, or re:<regex>,
// case-insensitive, matched against schema.table when the pattern has a dot
// and against the table name otherwise.
import { UserError } from "./errors.ts";
import { qualifiedName } from "./naming.ts";
import type { Scope } from "./types.ts";

type Named = { schema?: string | null; name: string };

const cache = new Map<string, { re: RegExp; qualified: boolean }>();

function compile(pattern: string): { re: RegExp; qualified: boolean } {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let out: { re: RegExp; qualified: boolean };
  if (pattern.startsWith("re:")) {
    const body = pattern.slice(3);
    try {
      out = { re: new RegExp(`^(?:${body})$`, "i"), qualified: body.includes("\\.") };
    } catch (e) {
      throw new UserError(`Invalid regex in scope pattern "${pattern}": ${(e as Error).message}`);
    }
  } else {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    out = { re: new RegExp(`^${escaped}$`, "i"), qualified: pattern.includes(".") };
  }
  cache.set(pattern, out);
  return out;
}

export function validatePattern(pattern: string): string | null {
  try {
    compile(pattern);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function matchesPattern(pattern: string, table: Named): boolean {
  const { re, qualified } = compile(pattern);
  return re.test(qualified ? qualifiedName(table) : table.name);
}

// Matches a dotted name such as source.model against a pattern, for access rules.
export function matchesDotted(pattern: string, dotted: string): boolean {
  const dot = dotted.lastIndexOf(".");
  const named = dot < 0 ? { schema: null, name: dotted } : { schema: dotted.slice(0, dot), name: dotted.slice(dot + 1) };
  return matchesPattern(pattern, named);
}

export function inScope(scope: Scope | undefined, table: Named): boolean {
  const include = scope?.include ?? [];
  const exclude = scope?.exclude ?? [];
  if (include.length && !include.some((p) => matchesPattern(p, table))) return false;
  return !exclude.some((p) => matchesPattern(p, table));
}

export function filterInScope<T extends Named>(scope: Scope | undefined, tables: T[]): T[] {
  return tables.filter((t) => inScope(scope, t));
}
