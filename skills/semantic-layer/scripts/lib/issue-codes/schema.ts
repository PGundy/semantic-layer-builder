// Codes of the issues a file's JSON Schema finds (schemaIssues and evalSchemaIssues in lib/schema.ts),
// one per Ajv keyword.
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "schema.required": { level: "error", meaning: "A key the file's JSON Schema requires is missing." },
  "schema.unknown_property": { level: "error", meaning: "The file holds a key its JSON Schema does not know." },
  "schema.enum": { level: "error", meaning: "A value is not one of the values the JSON Schema allows there." },
  "schema.type": { level: "error", meaning: "A value is of the wrong kind: text, a number, true or false, a list or a map." },
  "schema.pattern": { level: "error", meaning: "A text value does not match the pattern the JSON Schema gives." },
  "schema.other": { level: "error", meaning: "A value breaks another rule of the file's JSON Schema." },
};
export default codes;
