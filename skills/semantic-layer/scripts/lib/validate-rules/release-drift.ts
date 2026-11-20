// Retyped columns of the drift record (spec: Iterating a layer, The drift record): a warning on each
// approved field that reads a column semlayer introspect found retyped and that was neither edited nor
// approved again since. A record that cannot be read is skipped; the next introspect writes it again.
import { type DriftRecord, fieldsNow, readDrift, readOpen } from "../drift-record.ts";
import { pathText } from "../approval-hash.ts";
import type { Model } from "../types.ts";
import type { RuleContext } from "./index.ts";

export default function releaseDrift(ctx: RuleContext): void {
  let record: DriftRecord | null;
  try {
    record = readDrift(ctx.root);
  } catch {
    return;
  }
  for (const entry of record?.sources ?? []) {
    const loaded = ctx.models.get(entry.source);
    if (!loaded || !entry.retyped.length) continue;
    const models: Model[] = [...loaded.values()].map((m) => m.data);
    const files = new Map([...loaded.values()].map((m) => [m.data?.model, m.file]));
    const fields = fieldsNow(ctx.root, entry.source, models, ctx.sources.get(entry.source)?.data.dialect);
    for (const r of entry.retyped) {
      for (const read of r.reads) {
        const now = fields.get(read.ref);
        if (!now?.approved || !readOpen(read, now)) continue;
        const file = files.get(now.model);
        if (!file) continue;
        ctx.warn(
          file,
          pathText(now.path),
          `${read.ref} reads ${r.table}.${r.column}, which changed from ${r.from} to ${r.to} (found by semlayer introspect at ${r.at}), and was approved against the old type; ` +
            `its unit or meaning may have changed. Read it back to the owner with semlayer readback --targets ${read.ref}, edit it if the owner says so, and approve it again on their yes`,
          "release.column_retyped",
          `semlayer readback --targets ${read.ref}`,
        );
      }
    }
  }
}
