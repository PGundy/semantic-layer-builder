// The layer version and its changelog (spec: Iterating a layer, The changelog): changelog.yaml reads
// as a changelog, and layer_version in semantic.yaml is the version of its last entry. A layer with
// neither has never been released and gets no message. The open change round, .semlayer/change.json,
// reads as one (spec: Iterating a layer, The change round).
import { CHANGE_FILE, loadChange } from "../change-record.ts";
import { CHANGELOG_FILE, compareVersions, loadChangelog, VERSION_PATTERN } from "../release.ts";
import type { RuleContext } from "./index.ts";

export default function release(ctx: RuleContext): void {
  const open = loadChange(ctx.root);
  if (open.problem) ctx.error(CHANGE_FILE, "", `${CHANGE_FILE} is malformed: ${open.problem}. Delete the file to leave the round, or restore it from version control`, "release.change_malformed", "semlayer validate");
  const { log, problem } = loadChangelog(ctx.root);
  if (problem) {
    ctx.error(CHANGELOG_FILE, "", `${CHANGELOG_FILE} is malformed: ${problem}. Restore it from version control; the file is append-only and semlayer change close adds to it`, "release.changelog_malformed", "semlayer validate");
    return;
  }
  const last = log?.entries.at(-1);
  const version = ctx.project?.data.layer_version;
  if (version === undefined && !last) return;
  if (version !== last?.version)
    ctx.error(
      "semantic.yaml",
      "layer_version",
      last
        ? `layer_version is ${version ?? "not set"} but the last release in ${CHANGELOG_FILE} is ${last.version}; ` +
            (typeof version === "string" && VERSION_PATTERN.test(version) && compareVersions(version, last.version) > 0
              ? `if semlayer change close --version ${version} stopped before recording its entry, run it again to finish the release; else set layer_version to ${last.version}`
              : `set layer_version to ${last.version}, or restore ${CHANGELOG_FILE} if an entry was lost`)
        : `layer_version is ${version} but there is no ${CHANGELOG_FILE}; restore it from version control, or remove layer_version if no release was recorded`,
      "release.version_mismatch",
      "semlayer validate",
    );
}
