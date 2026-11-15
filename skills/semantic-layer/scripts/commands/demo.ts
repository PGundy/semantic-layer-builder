// semlayer demo: a sample project to try the skill on with no warehouse (spec: CLI, Demo project).
// It copies the plugin's synthetic Acme files into a new folder, sets up one DuckDB source over them
// through semlayer init and semlayer setup, and writes OWNER.md for the person playing the owner.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { DEMO_DIR, DEMO_NOW, DEMO_PROJECT, DEMO_PROMPT, DEMO_SHEET, DEMO_SOURCE, demoData, ownerSheet, pluginRoot } from "../lib/demo.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import initCommand from "./init.ts";
import setupCommand from "./setup.ts";

// The folder or one of its parents that holds a semantic.yaml, if any.
function enclosingRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "semantic.yaml"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

// Runs another command's run in the new folder with its output captured as JSON.
async function runIn(command: CommandSpec, values: Record<string, string | string[]>, ctx: CommandContext, dir: string): Promise<Record<string, unknown>> {
  const out: string[] = [];
  // The folder is private until it is renamed into place, so no other writer can reach it. Without
  // SEMLAYER_NOW the clock is DEMO_NOW, so the snapshot's captured_at is the same on every run.
  const now = ctx.env.SEMLAYER_NOW ? ctx.now : () => new Date(DEMO_NOW);
  const sub: CommandContext = { ...ctx, root: join(dir, "semantic"), cwd: dir, json: true, now, out: (t) => out.push(t), lock: async () => () => {} };
  const code = await command.run({ values, positionals: [] }, sub);
  if (code !== 0) throw new UserError(`could not set up the sample project: ${out.join("\n")}`);
  return JSON.parse(out.join("\n") || "{}") as Record<string, unknown>;
}

// A path to type after cd, quoted when it holds a space or a shell character.
const shellPath = (p: string) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

const spec: CommandSpec = {
  summary: "Make a sample project to try semlayer on, with synthetic data and no warehouse.",
  usage:
    `demo [--dir <dir>]\n\n` +
    `  Makes <dir> (default ./${DEMO_DIR}) holding data/ (a synthetic online store's tables as CSV and Parquet, copied\n` +
    `  from the plugin), semantic/ (a semantic root with one duckdb source, ${DEMO_SOURCE}, over those files, set up as\n` +
    `  semlayer setup does) and ${DEMO_SHEET}, a cheat sheet for you as the data owner. Needs no network, connection or secret.\n` +
    "  Refuses, changing nothing, when <dir> exists and is not empty or is inside a semantic root. --root is ignored:\n" +
    "  the root is <dir>/semantic.",
  options: { dir: { type: "string" } },
  // It creates a new semantic root and takes no lock on the current one.
  writes: "late",
  async run({ values }, ctx) {
    const dirArg = str(values, "dir") ?? DEMO_DIR;
    if (!dirArg.trim()) throw new UserError(`--dir needs a folder name; run semlayer demo --dir ${DEMO_DIR}.`, `semlayer demo --dir ${DEMO_DIR}`);
    const target = resolve(ctx.cwd, dirArg);
    // lstat, so a symlink (even to an empty folder, or to nothing) counts as existing.
    const found = (() => {
      try {
        return lstatSync(target);
      } catch {
        return undefined;
      }
    })();
    if (found && (!found.isDirectory() || readdirSync(target).length > 0)) {
      throw new UserError(
        `${target} already exists and is not empty; semlayer demo never writes over files. Run semlayer demo --dir <a new folder>.`,
        "semlayer demo --dir <a new folder>",
      );
    }
    const root = enclosingRoot(target);
    if (root) {
      throw new UserError(
        `${target} is inside the semantic root ${root}; a demo project is a folder of its own. Run semlayer demo --dir <a folder outside it>.`,
        "semlayer demo --dir <a folder outside it>",
      );
    }
    const data = demoData(pluginRoot());

    // Everything is made in a hidden folder beside the target and renamed into place at the end,
    // so a failure leaves nothing behind.
    mkdirSync(dirname(target), { recursive: true });
    const staging = join(dirname(target), `.${basename(target)}.semlayer-tmp-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    let tables = 0;
    try {
      for (const f of data.files) {
        mkdirSync(dirname(join(staging, "data", f)), { recursive: true });
        copyFileSync(join(data.acme, "data", f), join(staging, "data", f));
      }
      writeFileSync(join(staging, DEMO_SHEET), ownerSheet(data.figures));
      await runIn(initCommand, { name: DEMO_PROJECT, description: "A practice project over Acme, a synthetic online store; every value is made up." }, ctx, staging);
      const setup = await runIn(setupCommand, { source: DEMO_SOURCE, dialect: "duckdb", view: data.views.map(([name, relation]) => `${name}=${relation}`) }, ctx, staging);
      tables = Number((setup.snapshot as { tables?: number } | undefined)?.tables ?? 0);
      if (found) rmdirSync(target);
      renameSync(staging, target);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }

    const shown = relative(ctx.cwd, target);
    const cd = shellPath(shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : target);
    if (ctx.json) {
      ctx.out(
        formatJson({
          dir: target,
          data: { dir: "data", files: data.files.length },
          root: "semantic",
          project: DEMO_PROJECT,
          source: DEMO_SOURCE,
          tables,
          owner_sheet: DEMO_SHEET,
          synthetic: true,
          next: { cd: target, run: "claude", type: "/semlayer", say: DEMO_PROMPT },
        }),
      );
      return 0;
    }
    ctx.out(
      [
        `Made ${cd}: data/ holds a made-up online store (${tables} tables as CSV and Parquet; every value is synthetic),`,
        `semantic/ is a semantic layer set up over it with no connection or secret, and ${DEMO_SHEET} is your cheat sheet as the data owner.`,
        `Next: cd ${cd} && claude`,
        `Then type /semlayer (or say: "${DEMO_PROMPT}"), and answer the agent's questions as the owner, from ${DEMO_SHEET}.`,
      ].join("\n"),
    );
    return 0;
  },
};

export default spec;
