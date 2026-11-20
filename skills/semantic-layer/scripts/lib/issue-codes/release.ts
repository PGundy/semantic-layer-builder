// Codes of iterating a layer (spec: Iterating a layer): the drift record's retyped columns.
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "release.column_retyped": {
    level: "warning",
    meaning: "An approved field reads a column semlayer introspect found retyped, and the field was neither edited nor approved again since.",
    next: "semlayer readback --targets <ref>",
  },
};
export default codes;
