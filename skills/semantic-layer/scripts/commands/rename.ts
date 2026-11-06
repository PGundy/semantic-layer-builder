import type { CommandSpec } from "../lib/command.ts";
import { commitEdits, locate, pathText, questionLines, reapproveLines, referenceSites, type RefTarget, relFile, siteEdits } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadMetrics, loadProject } from "../lib/project.ts";
import { findField } from "../lib/refs.ts";
import { NAME_PATTERN } from "../lib/types.ts";

const spec: CommandSpec = {
  summary: "Rename a dimension, measure, join or metric and every reference to it, in one validated write.",
  usage: "rename <source.model.field | metric:<name>> <new_name>",
  options: {},
  positionals: true,
  async run({ positionals }, ctx) {
    loadProject(ctx.root);
    const [ref, raw, ...extra] = positionals;
    if (!ref || !raw || extra.length) throw new UserError("Usage: sl rename <source.model.field | metric:<name>> <new_name>, for example sl rename warehouse.orders.revenue gross_revenue.");
    const loc = locate(ctx.root, ref);
    if (loc.kind === "model" || loc.kind === "access") {
      throw new UserError(
        loc.kind === "model"
          ? "sl rename renames a dimension, measure, join or metric. A model's name is its file name: rename the file and its model key together, update every reference, and run sl validate."
          : "access.yaml has no name to rename; rename a field or metric instead (sl rename <source.model.field> <new_name>).",
      );
    }
    const metric = loc.kind === "metric";
    const name = metric ? raw.replace(/^metric:/, "") : raw;
    if (!NAME_PATTERN.test(name)) throw new UserError(`"${raw}" is not a name: a name is lowercase and matches ^[a-z][a-z0-9_]*$, such as gross_revenue.`);
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
