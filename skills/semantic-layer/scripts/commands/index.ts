import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "../lib/command.ts";

// Every file in this directory except this one is a command named after the file
// (add-source.ts is `sl add-source`). Commands load lazily, so a broken or slow
// module never affects the others, and adding a command needs no edit here.
const DIR = import.meta.dir;

function discover(): Record<string, () => Promise<{ default: CommandSpec }>> {
  const out: Record<string, () => Promise<{ default: CommandSpec }>> = {};
  for (const file of readdirSync(DIR).sort()) {
    if (!file.endsWith(".ts") || file === "index.ts" || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    const name = file.slice(0, -3);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
    out[name] = () => import(join(DIR, file)) as Promise<{ default: CommandSpec }>;
  }
  return out;
}

export const COMMANDS = discover();
