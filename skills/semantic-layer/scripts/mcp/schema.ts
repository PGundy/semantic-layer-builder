import Ajv2020 from "ajv/dist/2020.js";
import type { CommandSpec, OptionSpec } from "../lib/command.ts";
import { DENIED_FLAGS } from "../lib/roles.ts";

// The MCP tool for one CLI command: its name, its description and the JSON Schema of its arguments.
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface JsonSchema {
  type: string;
  description?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
}

// The tool arguments a command's flags do not provide.
export const ROOT_ARG = "root";
export const POSITIONALS_ARG = "positionals";
// The command options no tool takes: --show-protected is for the owner, run by hand (invariant 3).
export const DENIED_OPTIONS: readonly string[] = DENIED_FLAGS.map((f) => f.slice(2));

// The validator the server checks tool arguments with: JSON Schema 2020-12, strict about unknown keywords.
export function schemaValidator(): Ajv2020 {
  return new Ajv2020({ allErrors: true, strict: true });
}

// sl_<command>, with - as _ (check-join is sl_check_join).
export function toolName(command: string): string {
  return `sl_${command.replaceAll("-", "_")}`;
}

function optionSchema(name: string, o: OptionSpec): JsonSchema {
  const one: JsonSchema = { type: o.type };
  if (!o.multiple) return { ...one, description: `--${name}` };
  return { type: "array", items: one, description: `--${name}, once per item` };
}

export function inputSchema(spec: CommandSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, o] of Object.entries(spec.options)) if (!DENIED_OPTIONS.includes(name)) properties[name] = optionSchema(name, o);
  if (spec.positionals) {
    properties[POSITIONALS_ARG] = {
      type: "array",
      items: { type: "string" },
      description: "The words the usage line shows without a flag, in order (a subcommand, a ref, a key or a value).",
    };
  }
  properties[ROOT_ARG] = {
    type: "string",
    description: "The semantic root. Optional: the server's own root, the only one it accepts.",
  };
  return { type: "object", properties, additionalProperties: false };
}

export function toolOf(command: string, spec: CommandSpec): Tool {
  const denied = DENIED_OPTIONS.filter((o) => o in spec.options).map((o) => `--${o}`);
  const masked = denied.length ? ` This server never passes ${denied.join(" or ")}: protected values stay masked (invariant 3).` : "";
  return {
    name: toolName(command),
    description: `${spec.summary}\n\nUsage: sl ${spec.usage}\n\nRuns as \`sl ${command} --json\` in the server's semantic root and returns its JSON output.${masked}`,
    inputSchema: inputSchema(spec),
  };
}

// The CLI arguments for a tool call whose arguments match inputSchema(spec). Every flag is written
// --name=value and the positionals follow "--", so no argument value is ever read as a flag.
export function argvOf(command: string, spec: CommandSpec, args: Record<string, unknown>, root: string): string[] {
  const out = [command];
  for (const name of Object.keys(spec.options)) {
    if (DENIED_OPTIONS.includes(name)) continue;
    const v = args[name];
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one === true) out.push(`--${name}`);
      else if (typeof one === "string") out.push(`--${name}=${one}`);
    }
  }
  out.push("--json", `--root=${root}`);
  const positionals = args[POSITIONALS_ARG];
  if (Array.isArray(positionals) && positionals.length) out.push("--", ...positionals.map(String));
  return out;
}
