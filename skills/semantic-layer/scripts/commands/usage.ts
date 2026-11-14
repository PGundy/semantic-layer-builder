import { lstatSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import type { CommandContext, CommandSpec, OptionValues } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { envFiles } from "../lib/env-file.ts";
import { UserError } from "../lib/errors.ts";
import { findTable, qualifiedName } from "../lib/naming.ts";
import { formatJson, plainText } from "../lib/output.ts";
import { inScope } from "../lib/patterns.ts";
import { loadProject, loadSource, requireSnapshot } from "../lib/project.ts";
import { effectiveScope } from "../lib/table-list.ts";
import type { Snapshot } from "../lib/types.ts";
import {
  ACCEPTED,
  conditionText,
  evidenceSentences,
  findInputs,
  loadUsage,
  monthOfFile,
  namesFor,
  readContext,
  sha256,
  type Subset,
  type TableUsage,
  UsageAcc,
  type UsageFile,
  type UsageSummary,
  usagePath,
  writeUsage,
} from "../lib/usage.ts";
import { sourceFlag } from "./tables.ts";

const USAGE =
  "usage add --source <s> <path>... [--schema <name>]... [--query-key <name>]\n" +
  "       usage show --source <s> [--table <t>]\n" +
  "       usage clear --source <s>\n\n" +
  "add reads saved queries, scratch files and query logs as evidence of what people query, and connects to nothing and runs none of it.\n" +
  `Each <path> is a file or a folder (walked in name order): ${ACCEPTED}.\n` +
  "A log element is a string of SQL or an object with its text under query, query_text, sql, sql_text, statement, statement_text,\n" +
  "querytxt or text (any case; --query-key names another), with calls or execution_count, start_time, creation_time, end_time or\n" +
  "last_seen, and user_name, usename, user_email or user used when present (users are counted, never stored).\n" +
  "A statement counts when it reads a table the source keeps: its in-scope snapshot tables, or every table of the --schema schemas.\n" +
  "It writes counts and shapes to snapshots/<s>.usage.json, never statement text; a later add adds to it, skipping a file already read.\n" +
  "show prints the evidence per table, with the sentences to put to the owner; clear removes the file.\n" +
  "--json (add): { source, file, added, already_read, others_not_read, summary }; (show): the file's content for the tables shown, each with evidence.";

function noun(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function subsetOf(values: OptionValues, ctx: CommandContext, source: string, snapshot: Snapshot): Subset {
  const config = loadSource(ctx.root, source);
  const schemas = list(values, "schema").map((s) => s.toLowerCase());
  if (schemas.length) {
    const known = new Set(snapshot.tables.map((t) => (t.schema ?? "").toLowerCase()));
    const missing = schemas.filter((s) => !known.has(s));
    if (missing.length)
      throw new UserError(
        `--schema ${missing.join(", ")}: the snapshot of ${source} has no table in ${missing.length === 1 ? "that schema" : "those schemas"}. ` +
          `Its schemas are ${[...known].sort().join(", ") || "none"}; name one of them, or run sl introspect --source ${source} --schemas <a,b> to read more.`,
      );
    const set = new Set(schemas);
    return { kept: (t) => set.has((t.schema ?? "").toLowerCase()), schemas: set };
  }
  const scope = effectiveScope(ctx.root, config);
  const kept = new Set(snapshot.tables.filter((t) => inScope(scope, t)));
  return { kept: (t) => kept.has(t), schemas: new Set([...kept].map((t) => (t.schema ?? "").toLowerCase())) };
}

const COUNTED: (keyof Omit<UsageSummary, "not_understood_files">)[] = ["files", "statements", "kept", "other_schemas", "out_of_scope", "ambiguous", "not_in_snapshot", "no_table", "not_understood"];

function delta(before: UsageSummary, after: UsageSummary): UsageSummary {
  const out = { ...after, not_understood_files: after.not_understood_files.filter((f) => !before.not_understood_files.includes(f)) };
  for (const k of COUNTED) out[k] = after[k] - before[k];
  return out;
}

// One run's summary in plain words.
function summaryLines(s: UsageSummary, names: string[] = s.not_understood_files): string[] {
  const parts = [
    `${noun(s.kept, "statement")} kept`,
    s.other_schemas ? `${noun(s.other_schemas, "statement")} left out as other schemas` : "",
    s.out_of_scope ? `${noun(s.out_of_scope, "statement")} left out as reading only tables out of scope` : "",
    s.ambiguous ? `${noun(s.ambiguous, "statement")} ambiguous (an unqualified name more than one table has)` : "",
    s.not_in_snapshot ? `${noun(s.not_in_snapshot, "statement")} on a table not in the snapshot` : "",
    s.no_table ? `${noun(s.no_table, "statement")} that read no table` : "",
    s.not_understood ? `${noun(s.not_understood, "statement")} not understood${names.length ? ` (in ${names.map(plainText).join(", ")})` : ""}` : "",
  ].filter(Boolean);
  return [`Read ${noun(s.files, "file")} and ${noun(s.statements, "statement")}: ${parts.join(", ")}.`];
}

async function add(source: string, paths: string[], values: OptionValues, ctx: CommandContext): Promise<number> {
  if (!paths.length) throw new UserError(`Give the query files or their folder, as in sl usage add --source ${source} ./queries (${ACCEPTED}).`);
  const snapshot = requireSnapshot(ctx.root, source);
  const subset = subsetOf(values, ctx, source, snapshot);
  const { files, others } = findInputs(source, paths, ctx.cwd, ctx.root, envFiles(ctx.root, ctx.env));
  if (!files.length)
    throw new UserError(`${paths.join(", ")} holds no query file${others ? ` (${noun(others, "other file")} not read)` : ""}. sl usage add reads ${ACCEPTED}.`);
  const read = files
    .map((f) => {
      const bytes = readFileSync(f.abs);
      return { ...f, bytes, sha: sha256(bytes) };
    })
    .sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const existing = loadUsage(ctx.root, source);
  const acc = existing ? UsageAcc.from(existing) : new UsageAcc(source);
  const before = acc.toFile().summary;
  const rc = readContext(ctx.root, source, snapshot, subset, str(values, "query-key"));
  const added: UsageFile["inputs"] = [];
  const already: string[] = [];
  for (const f of read) {
    if (acc.has(f.sha)) {
      already.push(f.name);
      continue;
    }
    added.push(acc.add({ name: f.name, kind: f.kind, bytes: f.bytes.length, sha256: f.sha }, f.bytes.toString("utf8"), monthOfFile(f.abs), rc));
  }
  const file = acc.toFile();
  const target = usagePath(ctx.root, source);
  if (added.length) writeUsage(ctx.root, file);
  const run = delta(before, file.summary);
  const next = `sl usage show --source ${source}`;
  if (ctx.json) {
    ctx.out(formatJson({ source, file: relative(ctx.root, target), added: added.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), already_read: already.sort(), others_not_read: others, summary: run, next }));
    return 0;
  }
  const lines: string[] = [];
  if (added.length) {
    lines.push(...summaryLines(run));
    for (const s of added.filter((x) => x.skipped)) lines.push(`Skipped ${plainText(s.name)}: ${plainText(s.skipped!)}; fix it and add it again.`);
    const kept = Object.keys(file.tables).length;
    lines.push(`Wrote ${relative(ctx.root, target)}: ${noun(kept, "table")} of ${source} ${kept === 1 ? "appears" : "appear"} in saved queries. No statement text is stored.`);
    if (run.statements && !run.kept)
      lines.push(
        `No statement read here reads a table ${source} keeps. If these queries are for another source, run sl usage clear --source ${source}, then sl usage add with that --source; if they read another schema of ${source}, run sl usage clear --source ${source}, then sl usage add again with --schema <name> or after widening sl scope.`,
      );
  } else lines.push(`Nothing new: every file given was read before. ${relative(ctx.root, target)} is unchanged.`);
  if (already.length) lines.push(`Already read, skipped: ${already.map(plainText).join(", ")}.`);
  if (others) lines.push(`${noun(others, "other file")} in those folders ${others === 1 ? "is" : "are"} not a query file and ${others === 1 ? "was" : "were"} not read.`);
  lines.push(`Next: ${next} for the evidence, and sl tables --source ${source} to scope from what people query.`);
  ctx.out(lines.join("\n"));
  return 0;
}

function tableLines(q: string, t: TableUsage, sentences: string[]): string[] {
  const span = t.first ? (t.first === t.last ? `, in ${t.first}` : `, ${t.first} to ${t.last}`) : "";
  const lines = [
    `${q}: ${noun(t.statements, "statement")}${t.weighted !== t.statements ? ` (${t.weighted.toLocaleString("en-US")} with call counts)` : ""} in ${noun(t.files, "file")}` +
      `${t.users ? `, by ${noun(t.users, "user")}` : ""}${span}`,
  ];
  const list = (label: string, items: string[]) => items.length && lines.push(`  ${label}: ${items.map(plainText).join("; ")}`);
  list("aggregates", t.aggregates.slice(0, 5).map((g) => `${g.fn}(${g.expr}) ${g.count}`));
  list("conditions", t.conditions.slice(0, 5).map((c) => `${conditionText(c)} ${c.count}`));
  list("joins", t.joins.slice(0, 5).map((j) => `${j.with} on ${j.keys.join(" and ")} ${j.count}`));
  list("split by", t.group_by.slice(0, 5).map((g) => `${g.column}${g.grain ? ` by ${g.grain}` : ""} ${g.count}`));
  list("also joined, outside the source's kept tables", t.outside.slice(0, 5).map((o) => `${o.table} ${o.count}`));
  for (const s of sentences) lines.push(`  Evidence to ask about: ${plainText(s)}`);
  return lines;
}

function show(source: string, values: OptionValues, ctx: CommandContext): number {
  const file = loadUsage(ctx.root, source);
  if (!file) {
    const text = `No usage evidence for ${source} yet. When the owner has saved queries, scratch files or a query log, run sl usage add --source ${source} <path>.`;
    ctx.out(ctx.json ? formatJson({ source, usage: null, next: `sl usage add --source ${source} <path>` }) : text);
    return 0;
  }
  const snapshot = requireSnapshot(ctx.root, source);
  const names = namesFor(ctx.root, source, snapshot);
  const wanted = str(values, "table");
  let keys = Object.keys(file.tables).sort((a, b) => file.tables[b]!.statements - file.tables[a]!.statements || (a < b ? -1 : 1));
  if (wanted !== undefined) {
    const t = findTable(snapshot.tables, wanted);
    if (!t) throw new UserError(`No table "${wanted}" in the snapshot of ${source}. Run sl tables --source ${source} for the names.`);
    keys = keys.filter((k) => k === qualifiedName(t));
    if (!keys.length) {
      ctx.out(ctx.json ? formatJson({ source, table: qualifiedName(t), usage: null }) : `No saved query read ${qualifiedName(t)}. Next: sl usage show --source ${source} for the tables they do read.`);
      return 0;
    }
  }
  if (ctx.json) {
    const tables = Object.fromEntries(keys.map((k) => [k, { ...file.tables[k]!, evidence: evidenceSentences(k, file.tables[k]!, names) }]));
    ctx.out(formatJson({ ...file, tables, from: "query files" }));
    return 0;
  }
  const lines = [`Usage evidence for ${source}, from saved queries (evidence to ask the owner about, never a rule on its own):`, ...summaryLines(file.summary)];
  for (const k of keys) lines.push(...tableLines(k, file.tables[k]!, evidenceSentences(k, file.tables[k]!, names)));
  if (wanted === undefined && file.not_in_snapshot.length)
    lines.push(`Not in the snapshot (old or renamed tables, attributed to nothing): ${file.not_in_snapshot.map((s) => `${plainText(s.table)} ${s.count}${s.last ? ` (last ${s.last})` : ""}`).join("; ")}`);
  if (wanted === undefined && file.ambiguous.length) lines.push(`Ambiguous names, not attributed: ${file.ambiguous.map((a) => `${plainText(a.name)} ${a.count}`).join("; ")}`);
  lines.push(`Next: put the evidence to the owner as a question, with its counts; a rule exists only once the owner confirms it.`);
  ctx.out(lines.join("\n"));
  return 0;
}

function clear(source: string, ctx: CommandContext): number {
  const target = usagePath(ctx.root, source);
  const file = lstatSync(target, { throwIfNoEntry: false });
  if (file) rmSync(target);
  if (ctx.json) ctx.out(formatJson({ source, file: relative(ctx.root, target), removed: !!file }));
  else ctx.out(file ? `Removed ${relative(ctx.root, target)}. Next: sl usage add --source ${source} <path> to read query files again.` : `No usage evidence for ${source}; nothing to remove.`);
  return 0;
}

const spec: CommandSpec = {
  summary: "Read saved queries, scratch files and query logs as evidence of which tables, joins, sums and filters people use, or show or clear that evidence.",
  usage: USAGE,
  options: {
    source: { type: "string" },
    schema: { type: "string", multiple: true },
    "query-key": { type: "string" },
    table: { type: "string" },
  },
  positionals: true,
  writes: ({ positionals }) => (positionals[0] === "show" ? false : "whole"),
  async run({ values, positionals }, ctx) {
    const project = loadProject(ctx.root);
    const [sub, ...rest] = positionals;
    if (sub !== "add" && sub !== "show" && sub !== "clear") throw new UserError(`Usage: sl ${USAGE.split("\n\n")[0]!.replace(/\n\s+/g, " | sl ")}`);
    const source = sourceFlag(values, project);
    loadSource(ctx.root, source);
    if (sub === "add") return add(source, rest, values, ctx);
    if (rest.length) throw new UserError(`sl usage ${sub} takes no paths; it reads snapshots/${source}.usage.json.`);
    return sub === "show" ? show(source, values, ctx) : clear(source, ctx);
  },
};
export default spec;
