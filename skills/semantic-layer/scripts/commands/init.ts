import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { str } from "../lib/command.ts";
import { UserError } from "../lib/errors.ts";
import { ignoreLock } from "../lib/lock.ts";
import { paths } from "../lib/project.ts";
import { DEFAULT_BATCH_SIZE, DEFAULT_FOCUS_THRESHOLD, NAME_PATTERN, type Project } from "../lib/types.ts";
import { writeYaml } from "../lib/yaml.ts";

const spec: CommandSpec = {
  summary: "Create semantic.yaml and the directory layout.",
  usage: "init --name <name> [--description <text>] [--default-source <source>]",
  options: { name: { type: "string" }, description: { type: "string" }, "default-source": { type: "string" } },
  writes: "whole",
  async run({ values }, ctx) {
    const name = str(values, "name");
    if (!name || !NAME_PATTERN.test(name)) throw new UserError("--name is required and must match ^[a-z][a-z0-9_]*$.");
    const p = paths(ctx.root);
    if (existsSync(p.project)) throw new UserError(`${p.project} already exists.`);
    const project: Project = { version: 1, name };
    const description = str(values, "description");
    if (description) project.description = description;
    const def = str(values, "default-source");
    if (def) project.default_source = def;
    // The settings are written out so the owner can see and change them.
    project.settings = { focus_threshold: DEFAULT_FOCUS_THRESHOLD, batch_size: DEFAULT_BATCH_SIZE };
    writeYaml(p.project, project);
    for (const dir of [p.sourcesDir, p.snapshotsDir, `${ctx.root}/models`, p.goldensDir]) mkdirSync(dir, { recursive: true });
    ignorePlans(ctx.root);
    if (ctx.json) ctx.out(JSON.stringify({ root: ctx.root, project }));
    else ctx.out(`Created ${p.project}. Next: sl add-source --name <source> --dialect <dialect>.`);
    return 0;
  },
};
// Query plans and their results (.sl/plans/) and the lock a writing command holds (.sl/lock) are
// working files, never committed: init adds them to the root's .gitignore, appending to one that exists.
const PLANS_IGNORE = ".sl/plans/";
function ignorePlans(root: string): void {
  const file = join(root, ".gitignore");
  if (!existsSync(file)) {
    writeFileSync(file, `# Query plans and their results, written by --emit-sql and sl results add.\n${PLANS_IGNORE}\n`);
    return ignoreLock(root);
  }
  const text = readFileSync(file, "utf8");
  if (!text.split(/\r?\n/).some((l) => l.trim() === PLANS_IGNORE)) appendFileSync(file, `${text.endsWith("\n") || !text ? "" : "\n"}${PLANS_IGNORE}\n`);
  ignoreLock(root);
}

export default spec;
