import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildBaseline, renderBaseline } from "../lib/baseline.ts";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { listModels, loadProject, loadSource, paths, projectSettings, requireSnapshot } from "../lib/project.ts";
import type { SourceConfig } from "../lib/types.ts";
import { sourceFlag } from "./tables.ts";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// The project's own files and directories, relative to the semantic root: --out never writes there.
function projectEntries(root: string): { files: string[]; dirs: string[] } {
  const p = paths(root);
  return {
    files: [p.project, p.metrics, p.access].map((f) => relative(root, f).toLowerCase()),
    dirs: [p.sourcesDir, p.snapshotsDir, join(root, "models"), p.goldensDir].map((d) => relative(root, d).toLowerCase()),
  };
}

const BRIEF_HEADING = "# Baseline brief";

// The --out path, resolved from the semantic root. It is refused when it is empty, leaves the root
// (also through a symbolic link in an existing parent directory), is itself a symbolic link or a
// directory, has a parent that is a file, names one of the project's own files or a path under its
// sources, snapshots, models or goldens directories, or names an existing file that is not a
// baseline brief.
function outPath(root: string, out: string): string {
  if (!out.trim()) throw new UserError("--out needs a file path, such as baseline.md.");
  const base = resolve(root);
  const target = resolve(base, out);
  if (!inside(base, target)) throw new UserError(`--out ${out} is outside the semantic root ${root}; give a path inside it, such as baseline.md.`);
  const rel = relative(base, target).split(sep).join("/").toLowerCase();
  const own = projectEntries(base);
  if (own.files.includes(rel)) throw new UserError(`--out ${out} is one of the project's own files; give another path, such as baseline.md.`);
  const dir0 = own.dirs.find((d) => rel === d || rel.startsWith(`${d}/`));
  if (dir0) throw new UserError(`--out ${out} is inside the project's ${dir0}/ directory, which sl manages; give another path, such as baseline.md.`);
  for (let parent = dirname(target); parent !== base && inside(base, parent); parent = dirname(parent)) {
    let pstat: ReturnType<typeof statSync> | undefined;
    try {
      pstat = statSync(parent);
    } catch {
      pstat = undefined;
    }
    if (pstat && !pstat.isDirectory()) throw new UserError(`--out ${out}: ${relative(base, parent)} is a file, not a directory; give another path.`);
  }
  let dir = dirname(target);
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    const realDir = realpathSync(dir);
    if (realDir !== realRoot && !inside(realRoot, realDir)) {
      throw new UserError(`--out ${out} leads outside the semantic root ${root} through a link; give a path inside it.`);
    }
  }
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(target);
  } catch {
    stat = undefined;
  }
  if (stat?.isDirectory()) throw new UserError(`--out ${out} is a directory; give a file path such as ${out.replace(/\/+$/, "")}/baseline.md.`);
  if (stat?.isSymbolicLink()) throw new UserError(`--out ${out} is a symbolic link, which could lead outside the semantic root ${root}; give a plain file path.`);
  if (stat?.isFile() && !readFileSync(target, "utf8").startsWith(BRIEF_HEADING)) {
    throw new UserError(`--out ${out} already exists and is not a baseline brief, so it is not overwritten; give a new path or remove the file first.`);
  }
  return target;
}

const spec: CommandSpec = {
  summary:
    "Write a read-only baseline brief from the snapshot: per table its likely role, grain, keys, relationships, candidate measures and splits, " +
    "and the questions to ask the owner, plus a star-schema sketch. Reads no database.",
  usage: "baseline --source <source> [--tables t,...] [--out <file>]",
  options: {
    source: { type: "string" },
    tables: { type: "string", multiple: true },
    out: { type: "string" },
  },
  async run({ values }, ctx) {
    const project = loadProject(ctx.root);
    const sourceName = sourceFlag(values, project);
    const snapshot = requireSnapshot(ctx.root, sourceName);
    // The source file adds scope and strip prefixes; the brief works from the snapshot without it.
    const source: SourceConfig | null = existsSync(paths(ctx.root).source(sourceName)) ? loadSource(ctx.root, sourceName) : null;
    const { focus_threshold } = projectSettings(project);
    const models = listModels(ctx.root, sourceName).map((l) => l.model);
    const out = str(values, "out");
    const target = out !== undefined ? outPath(ctx.root, out) : undefined;
    const report = buildBaseline(snapshot, {
      source: sourceName,
      ...(source?.scope ? { scope: source.scope } : {}),
      focusThreshold: focus_threshold,
      tables: list(values, "tables"),
      stripPrefixes: source?.draft?.strip_prefixes ?? [],
      models,
    });
    const markdown = renderBaseline(report);
    if (target) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, markdown);
    }
    if (ctx.json) {
      ctx.out(formatJson({ ...report, ...(target ? { written_to: target } : {}) }));
      return 0;
    }
    if (target) {
      ctx.out(`Wrote the baseline brief for ${sourceName} (${report.tables.length} table${report.tables.length === 1 ? "" : "s"}) to ${relative(ctx.cwd, target) || target}.`);
    } else {
      ctx.out(markdown.trimEnd());
    }
    ctx.err(`Next: ${report.next}`);
    return 0;
  },
};
export default spec;
