import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { type CompileResult, compileRequest, type Refusal } from "../lib/compiler/index.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson, plainText } from "../lib/output.ts";
import { parseYamlText } from "../lib/yaml.ts";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// --request: a JSON object, or a YAML or JSON file holding a request or a whole golden (its
// request, role and user).
function readRequest(text: string, cwd: string): { request: unknown; golden?: string; role?: string; user?: Record<string, unknown> } {
  let doc: unknown;
  if (text.trim().startsWith("{")) {
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new UserError(`--request is not valid JSON: ${(e as Error).message}`);
    }
  } else {
    const path = resolve(cwd, text);
    if (!existsSync(path)) throw new UserError(`--request: no file ${text}. Pass a request as a JSON object or a file holding one.`);
    doc = parseYamlText(readFileSync(path, "utf8"), text);
  }
  if (!isObj(doc)) throw new UserError('--request must be a JSON object, such as {"source": "lake", "measures": ["sessions.session_count"]}.');
  if (!isObj(doc.request)) return { request: doc };
  return {
    request: doc.request,
    ...(typeof doc.name === "string" ? { golden: doc.name } : {}),
    ...(typeof doc.role === "string" ? { role: doc.role } : {}),
    ...(isObj(doc.user) ? { user: doc.user } : {}),
  };
}

function parseUser(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new UserError(`--user is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObj(v)) throw new UserError('--user must be a JSON object of user attributes, such as {"department": "sales"}.');
  return v;
}

// The sl access command that shows what this user, with this role, may see.
function accessCommand(user: Record<string, unknown>, role: string | undefined): string {
  const quoted = `'${JSON.stringify(user).replaceAll("'", "'\\''")}'`;
  return `sl access --user ${quoted}${role ? ` --roles ${role}` : ""}`;
}

// The command to run after a refusal, by its first kind of problem.
function nextStep(refusals: Refusal[], source: string, user: Record<string, unknown>, role: string | undefined, golden: string | undefined): string {
  const codes = refusals.map((r) => r.code);
  const who = accessCommand(user, role);
  if (codes.includes("invalid_request")) return "Fix the request (the request format is in references/spec.md, goldens) and run sl sql again.";
  if (codes.includes("invalid_layer")) return "Run sl validate and fix what it reports, then run sl sql again.";
  if (codes.includes("unknown_role") || codes.includes("not_visible"))
    return `Check each field name against the model YAML, and see what this user may see with ${who}.`;
  const own = refusals.find((r) => r.next);
  if (own) return own.next!;
  const run = codes.includes("unsupported_dialect") ? "run it with your own tool" : `run it with sl run --source ${source} --file <query.sql>`;
  const check = golden ? `sl goldens run --name ${golden}` : `write it from the model YAML and ${run}`;
  return `Until a later version compiles it, hand-written SQL computes this figure: ${check}.`;
}

const spec: CommandSpec = {
  summary: "Compile a request to SQL for a postgres or duckdb source, joins, ratio and derived metrics included, without running it.",
  usage:
    "sql --source <source> --request <file|json> [--role <role>] [--user <json object of attributes>]   " +
    "(prints the SQL and its parameters, or why it is refused; never runs it. --request may be a golden file, which also gives the role and user)",
  options: {
    source: { type: "string" },
    request: { type: "string" },
    role: { type: "string" },
    user: { type: "string" },
  },
  async run({ values }, ctx) {
    const text = str(values, "request");
    if (!text) throw new UserError("--request is required: a JSON object or a file holding a request.");
    const read = readRequest(text, ctx.cwd);
    const userFlag = str(values, "user");
    const user = userFlag !== undefined ? parseUser(userFlag) : (read.user ?? {});
    const role = str(values, "role") ?? read.role;
    const result: CompileResult = compileRequest(ctx.root, read.request, { source: str(values, "source"), role, user });
    if (!result.ok) {
      const next = nextStep(result.refusals, result.source, user, role, read.golden);
      if (ctx.json) ctx.out(formatJson({ ...result, next }));
      else {
        ctx.err(plainText(`sl sql refused the request: ${result.refusals.length === 1 ? result.reason : ""}`).trimEnd());
        if (result.refusals.length > 1) for (const r of result.refusals) ctx.err(plainText(`  - ${r.message}`));
        ctx.err(plainText(next));
      }
      return 1;
    }
    if (ctx.json) {
      ctx.out(formatJson(result));
      return 0;
    }
    ctx.out(plainText(result.sql));
    ctx.out("");
    const shown = result.params.map((v, i) => `$${i + 1} = ${JSON.stringify(v)}`).join(", ");
    ctx.out(plainText(`Parameters, bound in order: ${shown || "none"}`));
    for (const r of result.row_filters) {
      const where = (r.in === "where" ? "in WHERE" : `in the ON clause of its join ${r.alias}`) + (r.part ? ` of the part "${r.part} measures"` : "");
      const who = `${r.roles.length > 1 ? "roles" : "role"} ${r.roles.join(", ")}`;
      ctx.out(
        plainText(
          r.rows === "none"
            ? `This user sees no rows of ${r.model} (${who}), so the SQL reads false ${where}; ${accessCommand(user, role)} says why.`
            : `Row filters of ${who} limit ${r.model} ${where}, with the user's attributes bound as parameters.`,
        ),
      );
    }
    ctx.out(
      `Compiled for ${result.dialect} from model ${result.model}; sl sql never runs it. Run it with the parameters bound and the session time zone UTC, ` +
        "and compare a golden's recorded rows with sl goldens check.",
    );
    return 0;
  },
};
export default spec;
