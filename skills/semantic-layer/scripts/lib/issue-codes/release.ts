// Codes of iterating a layer (spec: Iterating a layer): the drift record's retyped columns, and the
// changelog and layer version.
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "release.column_retyped": {
    level: "warning",
    meaning: "An approved field reads a column semlayer introspect found retyped, and the field was neither edited nor approved again since.",
    next: "semlayer readback --targets <ref>",
  },
  "release.changelog_malformed": {
    level: "error",
    meaning: "changelog.yaml does not read as a changelog: it is not valid YAML, does not match its schema, or its versions do not rise.",
    next: "semlayer validate",
  },
  "release.version_mismatch": {
    level: "error",
    meaning: "layer_version in semantic.yaml is not the version of the last changelog entry.",
    next: "semlayer validate",
  },
  "release.change_malformed": {
    level: "error",
    meaning: "The open change round, .semlayer/change.json, is not valid JSON or does not match its schema.",
    next: "semlayer validate",
  },
  "release.change_open": {
    level: "error",
    meaning: "A change round is already open, so semlayer change start refuses to open a second one.",
    next: "semlayer change status",
  },
  "release.change_unreleased": {
    level: "error",
    meaning: "The layer has no release yet, so there is no version to start a change round from.",
    next: "semlayer change close --version 1.0",
  },
  "release.change_missing_input": {
    level: "error",
    meaning: "semlayer change start needs --note (what the change is for) and --by (who asked for it).",
    next: "semlayer change start --note <what the owner wants changed> --by <owner>",
  },
  "release.change_too_long": {
    level: "error",
    meaning: "The note given to semlayer change start is over 500 characters or the name over 200.",
    next: "semlayer change start --note <what the owner wants changed> --by <owner>",
  },
  "release.close_missing_version": {
    level: "error",
    meaning: "semlayer change close needs --version, the version the owner chose for the release.",
    next: "semlayer change close --version <version>",
  },
  "release.version_invalid": {
    level: "error",
    meaning: "The version given to semlayer change close is not major.minor, such as 1.1.",
    next: "semlayer change close --version <version>",
  },
  "release.version_not_above": {
    level: "error",
    meaning: "The version given to semlayer change close is not above the last release in changelog.yaml, so one version would be recorded twice.",
    next: "semlayer change close --version <version>",
  },
  "release.close_no_round": {
    level: "error",
    meaning: "The layer is released and no change round is open, so semlayer change close has nothing to record.",
    next: "semlayer change start --note <what the owner wants changed> --by <owner>",
  },
  "release.close_blocked": {
    level: "error",
    meaning:
      "semlayer change close refused: an item that was approved (or is in the last release) is changed or not approved again, a confirmed golden reads a draft the release would leave out, semlayer validate has an error, or an affected golden's figures moved from its recorded rows and the owner has not confirmed the new rows. A draft never approved that the last release does not hold never blocks: it is left out. The message lists each blocker with its command.",
    next: "semlayer change close --version <version>",
  },
};
export default codes;
