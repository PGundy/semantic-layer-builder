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
}

export interface CommandSpec {
  summary: string;
  usage: string;
  options: Record<string, OptionSpec>;
  positionals?: boolean;
  run(input: { values: OptionValues; positionals: string[] }, ctx: CommandContext): Promise<number>;
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
