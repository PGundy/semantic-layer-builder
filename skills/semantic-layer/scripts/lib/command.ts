export type OptionSpec = { type: "string" | "boolean"; multiple?: boolean; short?: string };

export type OptionValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface CommandContext {
  root: string;
  cwd: string;
  env: Record<string, string | undefined>;
  json: boolean;
  now: () => Date;
  out: (text: string) => void;
  err: (text: string) => void;
  // Takes the semantic root's lock (lib/lock.ts), waiting for another writer, and returns its
  // release. A command whose `writes` is "late" calls it when its queries are done, reads again
  // what it is about to change, writes, and releases. A lock still held when the command ends is
  // released for it. Asking again while holding it is safe.
  lock: () => Promise<() => void>;
}

// How a command changes files under the semantic root, which decides how it takes the root's lock:
//   "whole"  it reads, changes and writes without waiting on anything else, so the lock is held
//            for its whole run (when the root has a semantic.yaml);
//   "late"   it queries a database first, or creates the root: it takes the lock itself with
//            ctx.lock(), only around the part that reads again and writes;
//   false    it writes nothing under the root, and takes no lock.
export type Writes = "whole" | "late" | false;

export interface CommandInput {
  values: OptionValues;
  positionals: string[];
}

export interface CommandSpec {
  summary: string;
  usage: string;
  options: Record<string, OptionSpec>;
  positionals?: boolean;
  // A function decides from the arguments: a subcommand, --emit-sql, a flag that turns writing off.
  writes: Writes | ((input: CommandInput) => Writes);
  run(input: CommandInput, ctx: CommandContext): Promise<number>;
}

// Today's date as an ISO date, from the context clock.
export function today(ctx: CommandContext): string {
  return ctx.now().toISOString().slice(0, 10);
}

export function str(values: OptionValues, key: string): string | undefined {
  const v = values[key];
  return typeof v === "string" ? v : undefined;
}

export function list(values: OptionValues, key: string): string[] {
  const v = values[key];
  const raw = Array.isArray(v) ? (v as unknown[]).map(String) : typeof v === "string" ? [v] : [];
  return raw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

export function bool(values: OptionValues, key: string): boolean {
  return values[key] === true;
}
