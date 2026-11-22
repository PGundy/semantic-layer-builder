import { isSeq, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool, list, str, today } from "../lib/command.ts";
import { commitEdit, itemMap, oneLine, placeKey } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { intakeSchemas } from "../lib/intake.ts";
import { ownerText } from "../lib/ledger.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject, loadSnapshot, loadSource, paths } from "../lib/project.ts";
import { type CrossSchemaPair, crossSchemaPairs, keyProblem, type PairKey, referencedSchema, splitKeyEnd } from "../lib/schema-scope.ts";
import type { Snapshot, SourceConfig } from "../lib/types.ts";

const USAGE =
  "add-cross-schema --source <s> --from <schema> --to <schema> [--keys <table>.<column>=<table>.<column>[,...]] [--constraint <name>[,<name>]]\n" +
  "add-cross-schema --source <s> --from <schema> --to <schema> --decline --reply <owner's words>";

// A schema name as a pair records it: one plain identifier.
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const spec: CommandSpec = {
  summary: "Record a draft schema pair a join may cross, with the keys that connect the two schemas, or the owner's no to one.",
  usage:
    `${USAGE}\n\n` +
    "--from is the schema holding the foreign key and --to the schema it references; a join either way between their tables is allowed\n" +
    "on the pair's keys once the owner approves the pair. --keys pairs a column of a table in --from with one of a table in --to:\n" +
    "--keys orders.customer_id=customers.customer_id. --constraint takes the keys of a foreign key the snapshot records by name.\n" +
    "Each key must be in the snapshot. The pair is written as a draft; keys added to a recorded pair send it back to draft.\n" +
    "--decline records that the owner does not want these schemas joined, in their words (--reply), and takes no keys.\n" +
    "Both schemas must be among the schemas the source reads (intake.schemas); semlayer setup --schemas adds one.",
  options: {
    source: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    keys: { type: "string", multiple: true },
    constraint: { type: "string", multiple: true },
    decline: { type: "boolean" },
    reply: { type: "string" },
  },
  writes: "whole",
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const [sourceName, from, to] = ["source", "from", "to"].map((k) => str(values, k)?.trim());
    const keyArgs = list(values, "keys");
    const constraints = list(values, "constraint");
    const decline = bool(values, "decline");
    if (!sourceName || !from || !to || (!decline && !keyArgs.length && !constraints.length)) {
      throw new UserError(
        `Usage: semlayer ${USAGE.split("\n").join(", or semlayer ")}; give --keys or --constraint, or --decline. For example semlayer add-cross-schema --source warehouse --from sales --to crm --constraint orders_customer_fk.`,
      );
    }
    for (const [flag, v] of [["from", from], ["to", to]] as const)
      if (!SCHEMA.test(v)) throw new UserError(`--${flag} "${v}" is not a schema name: a plain identifier, such as sales.`);
    if (from === to) throw new UserError(`--from and --to are both ${from}: a pair joins two schemas, and joins within one schema need no pair.`);
    const source = loadSource(ctx.root, sourceName);
    refuseUnread(source, from, to);

    const pairs = crossSchemaPairs(source);
    const reversed = pairs.findIndex((p) => p.from === to && p.to === from);
    if (reversed >= 0 && pairs[reversed]!.status !== "declined") {
      throw new UserError(
        `sources/${sourceName}.yaml already declares the pair ${to} -> ${from}, which allows joins either way. Nothing was written. ` +
          `Add the keys to it with semlayer add-cross-schema --source ${sourceName} --from ${to} --to ${from} --keys ..., or remove it first with semlayer remove-cross-schema --source ${sourceName} --from ${to} --to ${from}.`,
      );
    }
    const index = pairs.findIndex((p) => p.from === from && p.to === to);
    const prior = index >= 0 ? pairs[index] : undefined;

    let pair: CrossSchemaPair;
    if (decline) {
      if (keyArgs.length || constraints.length) throw new UserError("--decline records the owner's no to the pair and takes no --keys or --constraint. Nothing was written.");
      const raw = str(values, "reply");
      const reply = raw === undefined ? "" : oneLine(ownerText(raw).text);
      if (!reply) throw new UserError(`--decline needs --reply with the owner's words, such as --reply "No, keep to ${from}". Nothing was written.`);
      pair = { from, to, status: "declined", reply, declined_at: today(ctx) };
    } else {
      if (str(values, "reply") !== undefined) throw new UserError("--reply goes with --decline only; an approval rests on the owner's yes recorded with semlayer reply. Nothing was written.");
      const snapshot = loadSnapshot(ctx.root, sourceName);
      if (!snapshot) throw new UserError(`No snapshot for "${sourceName}", so the keys cannot be checked. Nothing was written. Run semlayer introspect --source ${sourceName} first.`);
      const added = [...constraintKeys(snapshot, sourceName, from, to, constraints), ...columnKeys(snapshot, sourceName, from, to, keyArgs)];
      const keys = prior?.status === "declined" ? [] : [...(prior?.keys ?? [])];
      for (const k of added) {
        const twin = keys.find((x) => x.from.toLowerCase() === k.from.toLowerCase() && x.to.toLowerCase() === k.to.toLowerCase());
        if (!twin) keys.push(k);
        else if (k.constraint && !twin.constraint) twin.constraint = k.constraint;
      }
      pair = { from, to, status: "draft", keys };
      const unchanged = prior && prior.status !== "declined" && JSON.stringify(prior.keys ?? []) === JSON.stringify(keys);
      if (unchanged) pair = prior;
    }

    const file = paths(ctx.root).source(sourceName);
    const outcome = commitEdit(ctx.root, file, `add cross-schema pair ${from} -> ${to}`, (doc) => {
      if (prior === pair) return;
      const root = itemMap(doc, []);
      const seq = root.get("cross_schema", true);
      const node = doc.createNode(pair);
      const at = index >= 0 ? index : reversed;
      if (isSeq(seq) && at >= 0) (seq as YAMLSeq).items[at] = node;
      else if (isSeq(seq) && (seq as YAMLSeq).items.length) (seq as YAMLSeq).items.push(node);
      else {
        const created = doc.createNode([]) as YAMLSeq;
        created.items.push(node);
        placeKey(doc, root, "cross_schema", created, ["draft", "profile", "scope", "intake", "connection"]);
      }
    });
    const target = `schema-pair:${sourceName}:${from}:${to}`;
    const next = pair.status === "declined" ? "semlayer next" : `semlayer approve --target ${target} --by "<owner>"`;
    if (ctx.json) {
      ctx.out(formatJson({ changed: outcome.changed, file: outcome.file, ref: target, pair, next }));
      return 0;
    }
    const lines: string[] = [];
    if (pair.status === "declined") {
      lines.push(`Recorded that the owner declined joining ${from} to ${to} in ${outcome.file}: no join crosses between them.`);
      if (prior?.status === "approved") lines.push(`This replaced the approved pair, whose approval is gone; any join across ${from} and ${to} now fails validate until the owner says yes again.`);
      lines.push(`Next: ${next}.`);
    } else {
      const what = outcome.changed ? `Recorded the draft pair ${from} -> ${to}` : `The pair ${from} -> ${to} already lists these keys`;
      lines.push(`${what} in ${outcome.file}, on ${pair.keys!.map((k) => `${k.from} = ${k.to}`).join(" and ")}.`);
      if (outcome.changed && prior?.status === "approved") lines.push("The pair was approved; with these keys it is a draft again, and its approval is gone until the owner says yes to it as it now stands.");
      lines.push(`Next: read the pair to the owner with semlayer readback --targets ${target}, and on their yes run ${next}; then semlayer add-join adds a join on these keys.`);
    }
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;

// Both schemas of a pair must be read by the source, so its snapshot can hold their tables.
function refuseUnread(source: SourceConfig, from: string, to: string): void {
  const listed = intakeSchemas(source);
  if (!listed.length) return;
  const missing = [from, to].filter((s) => !listed.includes(s));
  if (!missing.length) return;
  const env = source.connection?.env ?? "<VAR>";
  throw new UserError(
    `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not among the schemas source ${source.source} reads (${listed.join(", ")}). Nothing was written. ` +
      `Read ${missing.length === 1 ? "it" : "them"} first with semlayer setup --source ${source.source} --dialect ${source.dialect} --env ${env} --schemas ${[...listed, ...missing].join(",")}, which reads the catalog again, then run this again.`,
  );
}

// The keys of foreign keys the snapshot names, from a table of `from` into `to`.
function constraintKeys(snapshot: Snapshot, source: string, from: string, to: string, names: string[]): PairKey[] {
  const out: PairKey[] = [];
  for (const name of names) {
    let found = false;
    for (const table of snapshot.tables) {
      if (table.schema !== from) continue;
      for (const fk of table.foreign_keys ?? []) {
        if (fk.constraint !== name || referencedSchema(table, fk) !== to) continue;
        found = true;
        fk.columns.forEach((c, i) => out.push({ from: `${table.name}.${c}`, to: `${fk.references.table}.${fk.references.columns[i] ?? c}`, constraint: name }));
      }
    }
    if (!found)
      throw new UserError(
        `The snapshot of ${source} has no foreign key ${name} from a table of ${from} into ${to}. Nothing was written. ` +
          `Name the columns with --keys <table>.<column>=<table>.<column>, or run semlayer introspect --source ${source} if the catalog changed.`,
      );
  }
  return out;
}

// The --keys pairs, each checked against the snapshot and spelled as it spells them.
function columnKeys(snapshot: Snapshot, source: string, from: string, to: string, args: string[]): PairKey[] {
  return args.map((arg) => {
    const [left, right, ...rest] = arg.split("=").map((x) => x.trim());
    if (!left || !right || rest.length || !splitKeyEnd(left) || !splitKeyEnd(right))
      throw new UserError(`--keys takes <table>.<column>=<table>.<column> pairs separated by commas, such as orders.customer_id=customers.customer_id; got "${arg}". Nothing was written.`);
    const key = { from: left, to: right };
    const problem = keyProblem(snapshot, { from, to }, key);
    if (problem)
      throw new UserError(`${left}=${right}: ${problem}. Nothing was written. The left side is a table of ${from} and the right a table of ${to}; semlayer tables --source ${source} lists them.`);
    const spell = (end: string, schema: string) => {
      const p = splitKeyEnd(end)!;
      const t = snapshot.tables.find((x) => x.schema === schema && x.name.toLowerCase() === p.table.toLowerCase())!;
      const c = t.columns.find((x) => x.name.toLowerCase() === p.column.toLowerCase())!;
      return `${t.name}.${c.name}`;
    };
    return { from: spell(left, from), to: spell(right, to) };
  });
}
