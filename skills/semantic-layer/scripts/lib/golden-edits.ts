// semlayer goldens unconfirm and semlayer goldens remove (spec: Goldens, Unconfirming and removing a golden):
// the two typed edits that lower a golden's trust and never raise it, so neither needs the owner's yes.
// unconfirm returns a confirmed golden to draft; remove deletes a draft golden's file. Both run inside
// semlayer apply, whose batch restores the file when the batch is refused.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { isMap } from "yaml";
import type { CommandContext } from "./command.ts";
import { batchWrite } from "./edit.ts";
import { UserError } from "./errors.ts";
import { latestReply, readReplies } from "./ledger.ts";
import { formatJson, plainText } from "./output.ts";
import { listGoldens, paths, stem } from "./project.ts";
import { NAME_PATTERN } from "./types.ts";
import { parseYamlText, updateYaml } from "./yaml.ts";

// The keys a confirm writes beside status: unconfirm removes them, as approve --revoke removes approved_by, approved_at and approved_hash.
const CONFIRM_KEYS = ["confirmed_by", "confirmed_at", "confirmed_as"] as const;

interface Found {
  path: string;
  file: string;
  status: unknown;
}

// The golden file for --name, refused with a code and the next step when the name is not a golden.
function findGolden(ctx: CommandContext, sub: "unconfirm" | "remove", name: string | undefined): Found {
  if (!name?.trim()) throw new UserError(`semlayer goldens ${sub} needs --name <golden>. semlayer status lists the goldens.`, "semlayer status", "golden.unknown");
  const dir = resolve(paths(ctx.root).goldensDir);
  const path = resolve(paths(ctx.root).golden(name));
  const known = () => listGoldens(ctx.root).map((g) => stem(basename(g.path))).filter((n) => existsSync(paths(ctx.root).golden(n)));
  if (!NAME_PATTERN.test(name) || !path.startsWith(dir + sep) || !existsSync(path)) {
    const names = NAME_PATTERN.test(name) ? known() : [];
    throw new UserError(
      `There is no golden "${name}" (goldens/${name}.yaml), so nothing changed. Goldens: ${names.length ? names.join(", ") : "none"}; semlayer status lists them.`,
      "semlayer status",
      "golden.unknown",
    );
  }
  // A file that does not parse holds no valid confirmation, so remove treats it as a draft.
  let doc: { status?: unknown } | null = null;
  try {
    doc = parseYamlText(readFileSync(path, "utf8"), relative(ctx.root, path)) as { status?: unknown } | null;
  } catch (e) {
    if (sub === "unconfirm") throw e;
  }
  return { path, file: relative(ctx.root, path).split(sep).join("/"), status: doc && typeof doc === "object" ? doc.status : undefined };
}

// Returns a confirmed golden to draft: status draft, its confirmation (confirmed_by, confirmed_at,
// confirmed_as) and its recorded rows removed, its question, request, role, user, reference and tolerance kept.
// The owner's yes in the ledger stays as it was, and `unconfirmed_yes` names it (the id of the owner's latest reply
// to the golden), so semlayer next does not offer a confirm on it: a confirm again rests on a new yes to the rows its
// request compiles to then.
export function unconfirmGolden(ctx: CommandContext, name: string | undefined, reason: string | undefined): number {
  const g = findGolden(ctx, "unconfirm", name);
  if (g.status !== "approved")
    throw new UserError(
      `Golden ${name} is already a draft, so there is nothing to unconfirm; nothing changed. A draft golden is confirmed on the owner's yes: semlayer readback --targets golden:${name}, then semlayer goldens confirm --name ${name}.`,
      `semlayer readback --targets golden:${name}`,
      "golden.not_confirmed",
    );
  const setAside = latestReply(readReplies(ctx.root), `golden:${name}`)?.id;
  batchWrite(g.path);
  updateYaml(g.path, (doc) => {
    doc.set("status", "draft");
    if (setAside) doc.set("unconfirmed_yes", setAside);
    for (const k of CONFIRM_KEYS) doc.delete(k);
    // A draft records no rows; the tolerance the owner agreed stays for the next confirm.
    const expected = doc.get("expected", true);
    if (isMap(expected) && expected.has("tolerance")) expected.set("rows", doc.createNode([]));
    else doc.delete("expected");
  });
  const why = reason?.trim().replace(/\s+/g, " ");
  const next = `semlayer readback --targets golden:${name}`;
  if (ctx.json) {
    ctx.out(formatJson({ changed: [{ target: `golden:${name}`, from: "approved", to: "draft" }], file: g.file, ...(why ? { reason: why } : {}), next }));
    return 0;
  }
  ctx.out(
    plainText(
      [
        `Unconfirmed golden:${name} (approved -> draft)${why ? `: ${why}` : ""}. Its recorded rows and confirmation are removed from ${g.file}; its question, request and tolerance are kept.`,
        "semlayer goldens check no longer checks it, and a release leaves it out until the owner confirms it again.",
        `Next: when the owner can check its figures, ${next}, record their answer, then semlayer goldens confirm --name ${name}.`,
      ].join("\n"),
    ),
  );
  return 0;
}

// Removes a draft golden's file. A confirmed golden is refused: it is unconfirmed first, so removing a
// confirmed check is always two visible steps.
export function removeGolden(ctx: CommandContext, name: string | undefined): number {
  const g = findGolden(ctx, "remove", name);
  if (g.status === "approved")
    throw new UserError(
      `Golden ${name} is confirmed, so it is not removed; nothing changed. Return it to draft first with semlayer goldens unconfirm --name ${name}, then run semlayer goldens remove --name ${name}.`,
      `semlayer goldens unconfirm --name ${name}`,
      "golden.confirmed",
    );
  batchWrite(g.path);
  unlinkSync(g.path);
  const next = "semlayer status";
  if (ctx.json) {
    ctx.out(formatJson({ removed: `golden:${name}`, file: g.file, next }));
    return 0;
  }
  ctx.out(`Removed ${g.file}, a draft golden. To write the question again, run semlayer goldens new --name ${name} --question "<question>" --request <json>.\nNext: ${next}.`);
  return 0;
}
