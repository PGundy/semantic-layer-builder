// The JSON a batched owner-answer form reads (semlayer reply --answers, semlayer question resolve --answers): a
// file, or standard input with "-".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext } from "./command.ts";
import { UserError } from "./errors.ts";

// The JSON object `--<flag> <file | ->` holds. `usage` ends each refusal; nothing has been written.
export async function readJsonObject(ctx: CommandContext, flag: string, file: string, usage: string): Promise<Record<string, unknown>> {
  let text: string;
  if (file === "-") {
    if (!ctx.stdin) throw new UserError(`--${flag} - reads stdin, which this caller does not give; write the answers to a file and pass --${flag} <path>. ${usage}`);
    text = await ctx.stdin();
  } else {
    try {
      text = readFileSync(resolve(ctx.cwd, file), "utf8");
    } catch (e) {
      const code = (e as { code?: string }).code;
      const why = code === "ENOENT" ? "there is no such file" : code === "EISDIR" ? "it is a directory" : (e as Error).message;
      throw new UserError(`Cannot read ${file}: ${why}. Nothing was written. Write the answers to that file, or pass --${flag} - to read them from stdin. ${usage}`);
    }
  }
  const where = file === "-" ? "stdin" : file;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UserError(`${where} is not JSON (${(e as Error).message}); nothing was written. ${usage}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new UserError(`${where} is not a JSON object; nothing was written. ${usage}`);
  return data as Record<string, unknown>;
}

// The keys of an entry that are not `allowed`, for a refusal that names them.
export function unknownKeys(entry: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(entry).filter((k) => !allowed.includes(k));
}
