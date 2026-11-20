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
};
export default codes;
