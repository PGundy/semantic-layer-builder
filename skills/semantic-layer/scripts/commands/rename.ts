import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { CommandContext, CommandSpec } from "../lib/command.ts";
import { commitEdits, type Located, locate, pathText, questionLines, reapproveLines, referenceSites, type RefTarget, relFile, siteEdits } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadMetrics, loadProject, paths, stem } from "../lib/project.ts";
import { modelReferenceSites } from "../lib/rename-model.ts";
import { findField } from "../lib/refs.ts";
import { NAME_PATTERN } from "../lib/types.ts";
import { readYamlIfExists } from "../lib/yaml.ts";

// The lines that send approved items back to the owner, naming one readback for all of them.
function reapproveBlock(refs: string[]): string[] {
  if (refs.length <= 1) return reapproveLines(refs);
  return [
    `${refs.length} approved items changed and go back to the owner for re-approval; tools treat them as drafts until then. ` +
      `Read them back with sl readback --targets ${refs.join(",")}, record the owner's answers with sl reply, and approve each again only on their yes (sl approve --target <ref>).`,
  ];
}

// sl rename <source.model> <new_name>: moves the model file and renames every reference to it.
function renameModel(ctx: CommandContext, loc: Located, ref: string, name: string): number {
  const [source, old] = ref.split(".") as [string, string];
  const newRef = `${source}.${name}`;
  const fromFile = relFile(ctx.root, loc.file);
  if (name === old) {
    if (ctx.json) ctx.out(formatJson({ changed: false, file: fromFile, files: [], reapprove: [], ref, new_ref: newRef, references: [], renamed_file: null, goldens: [] }));
    else ctx.out(`${ref} is already named ${name}; nothing changed. Next: sl status.`);
    return 0;
  }
  const to = paths(ctx.root).model(source, name);
  if (existsSync(to) || existsSync(to.replace(/\.yaml$/, ".yml"))) {
    throw new UserError(`Source ${source} already has a model "${name}" (${relFile(ctx.root, to)}); pick another name, or run sl status to list the models.`);
  }
  const model = loc.model!;
  const fields = [...(model.dimensions ?? []), ...(model.measures ?? []), ...(model.joins ?? [])].map((f) => String(f.name));
  const { sites, conflicts } = modelReferenceSites(ctx.root, source, old, name, fields);
  if (conflicts.length) {
    throw new UserError(
      `Cannot rename ${ref}: an access.yaml pattern would change what it covers, and a rename never changes who sees what. Nothing was written:\n` +
        conflicts.map((c) => `  - ${c}`).join("\n") +
        `\nWith the owner, make each list cover ${newRef} as it covers ${ref}: add ${newRef} (or ${newRef}.<field>) to the same list as its own entry, or narrow the pattern, or pick another name. ` +
        `Revoke access.yaml first if it is approved (sl approve --target access --revoke), then run this again.`,
    );
  }
  const renamed = new Map([[newRef, ref], ...fields.map((f): [string, string] => [`${newRef}.${f}`, `${ref}.${f}`])]);
  const outcome = commitEdits(ctx.root, siteEdits(sites), `rename ${ref} to ${name}`, undefined, renamed, { move: { from: loc.file, to } });
  const toFile = relFile(ctx.root, to);
  const goldenDir = paths(ctx.root).goldensDir;
  const goldens = [...new Set(sites.filter((s) => s.file.startsWith(goldenDir)).map((s) => s.file))]
    .filter((f) => readYamlIfExists<{ status?: unknown }>(f)?.status === "approved")
    .map((f) => stem(basename(f)))
    .sort();
  const references = sites.slice(1).map((s) => ({ file: relFile(ctx.root, s.file === loc.file ? to : s.file), path: pathText(s.path), from: s.from, to: s.to }));
  if (ctx.json) {
    ctx.out(formatJson({ changed: outcome.changed, file: toFile, files: outcome.files, reapprove: outcome.reapprove, ref, new_ref: newRef, references, renamed_file: { from: fromFile, to: toFile }, goldens }));
    return 0;
  }
  const others = [...new Set(references.map((r) => r.file))].filter((f) => f !== toFile);
  const lines = [
    `Renamed model ${ref} to ${newRef}: ${fromFile} is now ${toFile}, with its model key` +
      (references.length ? `, and ${references.length} reference${references.length === 1 ? "" : "s"} to it${others.length ? ` in ${others.join(", ")}` : ""}.` : "; nothing else names it."),
  ];
  if ((model.open_questions ?? []).length) lines.push(`Its open questions stay as written in ${toFile}; edit any that name ${old} there.`);
  lines.push(...reapproveBlock(outcome.reapprove));
  if (goldens.length) {
    lines.push(
      `The request of ${goldens.length === 1 ? "a confirmed golden" : `${goldens.length} confirmed goldens`} changed (${goldens.map((g) => `golden:${g}`).join(", ")}): ` +
        `run sl goldens check, then read ${goldens.length === 1 ? "it" : "each"} back (sl readback --targets golden:<g>) and confirm it again only on the owner's yes (sl goldens confirm --name <g>).`,
    );
  }
  if (!outcome.reapprove.length && !goldens.length) lines.push("Next: sl status.");
  ctx.out(lines.join("\n"));
  return 0;
}

const spec: CommandSpec = {
  summary: "Rename a model, dimension, measure, join or metric and every reference to it, in one validated write.",
  usage: "rename <source.model | source.model.field | metric:<name>> <new_name>",
  options: {},
  positionals: true,
  writes: "whole",
  async run({ positionals }, ctx) {
    loadProject(ctx.root);
    const [ref, raw, ...extra] = positionals;
    if (!ref || !raw || extra.length) throw new UserError("Usage: sl rename <source.model | source.model.field | metric:<name>> <new_name>, for example sl rename warehouse.orders.revenue gross_revenue.");
    const loc = locate(ctx.root, ref);
    if (loc.kind === "access") throw new UserError("access.yaml has no name to rename; rename a model, field or metric instead (sl rename <source.model.field> <new_name>).");
    const metric = loc.kind === "metric";
    const name = metric ? raw.replace(/^metric:/, "") : raw;
    if (!NAME_PATTERN.test(name)) throw new UserError(`"${raw}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as gross_revenue.`);
    if (loc.kind === "model") return renameModel(ctx, loc, ref, name);
    const old = String(loc.item.name);
    const [source, model] = ref.split(".") as [string, string];
    const newRef = metric ? `metric:${name}` : `${source}.${model}.${name}`;
    const result = { ref, new_ref: newRef };
    if (name === old) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, loc.file), files: [], reapprove: [], ...result, references: [] }));
      else ctx.out(`${ref} is already named ${name}; nothing changed. Next: sl status.`);
      return 0;
    }
    if (metric) {
      if ((loadMetrics(ctx.root).metrics ?? []).some((m) => m?.name === name)) throw new UserError(`metrics.yaml already has a metric "${name}"; pick another name.`);
    } else {
      const taken = findField(loc.model!, name);
      if (taken) throw new UserError(`${source}.${model} already has a ${taken.kind} "${name}": dimensions, measures and joins share one namespace. Pick another name.`);
    }
    const target: RefTarget = metric
      ? { kind: "metric", name: old, source: String(loc.item.source ?? "") }
      : { kind: loc.kind as "dimension" | "measure" | "join", source, model, name: old };
    const { sites, conflicts } = referenceSites(ctx.root, target, name);
    if (conflicts.length) {
      throw new UserError(
        `Cannot rename ${ref}: an access.yaml pattern would change what it covers, and a rename never changes who sees what. Nothing was written:\n` +
          conflicts.map((c) => `  - ${c}`).join("\n") +
          `\nWith the owner, make each list cover ${newRef} as it covers ${ref}: when a pattern covers ${ref} only, add ${newRef} to the same list as its own entry; ` +
          `when it covers ${newRef} only, narrow the pattern or pick another name. Revoke access.yaml first if it is approved (sl approve --target access --revoke), then run this again.`,
      );
    }
    const own = { file: loc.file, path: [...loc.path, "name"], from: old, to: name };
    const outcome = commitEdits(ctx.root, siteEdits([own, ...sites]), `rename ${ref} to ${name}`, undefined, new Map([[newRef, ref]]));
    const references = sites.map((s) => ({ file: relFile(ctx.root, s.file), path: pathText(s.path), from: s.from, to: s.to }));
    if (ctx.json) {
      ctx.out(formatJson({ changed: outcome.changed, file: relFile(ctx.root, loc.file), files: outcome.files, reapprove: outcome.reapprove, ...result, references }));
      return 0;
    }
    const others = outcome.files.filter((f) => f !== relFile(ctx.root, loc.file));
    const lines = [
      `Renamed ${ref} to ${newRef} in ${relFile(ctx.root, loc.file)}` +
        (references.length ? `, and ${references.length} reference${references.length === 1 ? "" : "s"} to it${others.length ? ` in ${others.join(", ")}` : ""}.` : "; nothing else names it."),
    ];
    if (!metric) lines.push(...questionLines(loc.model, old, relFile(ctx.root, loc.file)));
    lines.push(...reapproveLines(outcome.reapprove));
    if (!outcome.reapprove.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;
