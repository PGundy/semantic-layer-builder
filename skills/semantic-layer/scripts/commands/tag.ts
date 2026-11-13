import { isSeq, type YAMLSeq } from "yaml";
import type { CommandSpec } from "../lib/command.ts";
import { bool } from "../lib/command.ts";
import { commitEdit, itemMap, locate, placeKey, protectionGuard, reapproveLines, relFile } from "../lib/edit.ts";
import { UserError } from "../lib/errors.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject } from "../lib/project.ts";
import { NAME_PATTERN, PROTECTED_TAGS } from "../lib/types.ts";

const TAGGABLE = new Set(["model", "dimension", "measure", "metric"]);

const spec: CommandSpec = {
  summary: "Add or remove tags (pii, sensitive, public or another) on a model, field or metric.",
  usage: "tag <source.model | source.model.field | metric:<name>> <tag>[,<tag>...] [--remove]",
  options: { remove: { type: "boolean" } },
  positionals: true,
  writes: "whole",
  async run({ values, positionals }, ctx) {
    loadProject(ctx.root);
    const remove = bool(values, "remove");
    const [ref, list, ...extra] = positionals;
    if (!ref || !list || extra.length) throw new UserError("Usage: sl tag <ref> <tag>[,<tag>...] [--remove], for example sl tag warehouse.customers.email pii.");
    const wanted = [...new Set(list.split(",").map((t) => t.trim()).filter(Boolean))];
    const bad = wanted.filter((t) => !NAME_PATTERN.test(t));
    if (!wanted.length || bad.length) throw new UserError(`A tag is a lowercase name matching ^[a-z][a-z0-9_]*$, such as pii, sensitive or public; got ${bad.join(", ") || "none"}.`);
    const loc = locate(ctx.root, ref);
    if (!TAGGABLE.has(loc.kind)) {
      const what = loc.kind === "access" ? "access.yaml carries" : `A ${loc.kind} carries`;
      throw new UserError(`${what} no tags; tag a model, a dimension, a measure or a metric instead, for example sl tag warehouse.customers.email pii.`);
    }

    const current = Array.isArray(loc.item.tags) ? loc.item.tags.map(String) : [];
    const touched = remove ? wanted.filter((t) => current.includes(t)) : wanted.filter((t) => !current.includes(t));
    const result = { ref, [remove ? "removed" : "added"]: touched, tags: remove ? current.filter((t) => !touched.includes(t)) : [...current, ...touched] };
    if (!touched.length) {
      if (ctx.json) ctx.out(formatJson({ changed: false, file: relFile(ctx.root, loc.file), reapprove: [], ...result }));
      else ctx.out(`${ref} ${remove ? "has none of" : "already has"} ${wanted.join(", ")}; nothing changed. Next: sl status.`);
      return 0;
    }
    const guard = protectionGuard(ref, current, result.tags as string[]);
    const outcome = commitEdit(ctx.root, loc.file, `${remove ? "untag" : "tag"} ${ref}`, (doc) => {
      const map = itemMap(doc, loc.path);
      const node = map.get("tags", true);
      if (remove) {
        if (!isSeq(node)) return;
        if (result.tags.length === 0) return void map.delete("tags");
        (node as YAMLSeq).items = node.items.filter((i) => !touched.includes(String((i as { value?: unknown }).value ?? i)));
        return;
      }
      if (isSeq(node)) {
        for (const t of touched) node.items.push(doc.createNode(t));
        return;
      }
      const created = doc.createNode(touched);
      created.flow = true;
      placeKey(doc, map, "tags", created, ["synonyms", "description", "grain", "type", "agg", "table"], ["status"]);
    }, guard);
    if (ctx.json) {
      ctx.out(formatJson({ ...outcome, ...result }));
      return 0;
    }
    const lines = [`${remove ? "Removed" : "Added"} ${touched.join(", ")} ${remove ? "from" : "on"} ${ref} in ${outcome.file}.`];
    const protectedTouched = touched.filter((t) => (PROTECTED_TAGS as readonly string[]).includes(t));
    if (protectedTouched.length && !remove && loc.source)
      lines.push(`If the snapshot holds sample values for it, run sl profile --source ${loc.source} --redact to keep counts only.`);
    if (protectedTouched.length && remove)
      lines.push(`Without ${protectedTouched.join(" or ")}, everyone who may see ${ref} sees its values once it is approved; confirm that with the owner.`);
    lines.push(...reapproveLines(outcome.reapprove));
    if (!outcome.reapprove.length) lines.push("Next: sl status.");
    ctx.out(lines.join("\n"));
    return 0;
  },
};
export default spec;
