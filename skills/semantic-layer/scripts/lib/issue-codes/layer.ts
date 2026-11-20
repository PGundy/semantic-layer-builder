// Codes of the checks of a layer's own files: models, metrics, access, goldens and approvals.
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "issue.unclassified": { level: "error", meaning: "A layer check, error or warning, that has no code of its own yet; read its level, path and message." },
};
export default codes;
