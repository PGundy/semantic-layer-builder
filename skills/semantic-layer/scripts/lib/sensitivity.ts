// Name and profile heuristics for columns whose values look personal or sensitive. sl draft tags
// the fields it drafts from them, and sl validate warns when an approved field everyone may see
// matches one without a pii, sensitive or public tag.
import { classifyType } from "./column-types.ts";
import { toSpecName } from "./naming.ts";
import type { ColumnProfile, SnapshotColumn } from "./types.ts";

export type SensitivityTag = "pii" | "sensitive";

export interface Sensitivity {
  tag: SensitivityTag;
  reason: string;
}

// Personal data by name. Matching starts at a snake_case word, so home_address and email_hash match.
export const PII_NAME =
  /(^|_)(email|phone|mobile|ssn|social_security|address|street|postal|zip|first_name|last_name|full_name|birth|dob|ip_address|passport|tax_id)/;

// A pattern matching any of `words` as whole snake_case words, each with its plural: salaries,
// bonuses, diagnoses and wages match, as do salary_band and card_id.
function wordsPattern(words: string[]): RegExp {
  const alts = words.map((w) =>
    /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}(?:y|ies)` : /is$/.test(w) ? `${w.slice(0, -2)}(?:is|es)` : `${w}(?:s|es)?`,
  );
  return new RegExp(`(^|_)(${alts.join("|")})(_|$)`);
}

// Pay, banking, payment-card and health words.
const SENSITIVE_PAY = wordsPattern([
  "salary",
  "compensation",
  "comp",
  "comp_band",
  "wage",
  "bonus",
  "payroll",
  "bank",
  "iban",
  "account_number",
  "routing",
  "card",
  "health",
  "medical",
  "diagnosis",
]);
// Credential and free-text words.
const SENSITIVE_TEXT = wordsPattern(["password", "secret", "token", "api_key", "notes", "note", "comment", "comments", "message", "free_text", "body", "reason_text"]);

export const NEAR_UNIQUE_RATIO = 0.9;
export const NEAR_UNIQUE_MIN_ROWS = 50;

// The column argument: a snapshot column (its type and profile), or a bare profile.
export type SensitivityColumn = Pick<SnapshotColumn, "type" | "profile"> | ColumnProfile | null | undefined;

export interface SensitivityOptions {
  // The column is a primary key or join key column, which the profile rule skips. Id-named
  // columns (id, *_id) always count as keys.
  key?: boolean;
}

function split(column: SensitivityColumn): { type?: string; profile?: ColumnProfile } {
  if (!column) return {};
  if ("type" in column && typeof column.type === "string") return { type: column.type, profile: (column as SnapshotColumn).profile };
  if ("profile" in column) return { profile: (column as SnapshotColumn).profile };
  return { profile: column as ColumnProfile };
}

// Whether the column holds strings: by its type when known, else by the values its profile holds.
function isString(type: string | undefined, profile: ColumnProfile | undefined): boolean {
  if (type !== undefined) return classifyType(type) === "string";
  const values = [...(profile?.top_values ?? []).map((v) => v.value), profile?.min, profile?.max].filter((v) => v !== null && v !== undefined);
  return values.length > 0 && values.every((v) => typeof v === "string");
}

// Whether a string column has a different value on nearly every row of a table of at least 50 rows.
export function nearUnique(profile: ColumnProfile | undefined, rowCount: number | null | undefined): boolean {
  const distinct = profile?.distinct_count;
  return (
    typeof distinct === "number" &&
    typeof rowCount === "number" &&
    rowCount >= NEAR_UNIQUE_MIN_ROWS &&
    distinct / rowCount > NEAR_UNIQUE_RATIO
  );
}

// pii when the name looks like personal data; sensitive when the name holds a pay, banking, card,
// health, credential or free-text word, whatever the column's type and whether or not it is a key,
// or when a string column that is not a key is near-unique; null otherwise.
export function sensitivityOf(
  columnName: string,
  column?: SensitivityColumn,
  rowCount?: number | null,
  opts: SensitivityOptions = {},
): Sensitivity | null {
  const norm = toSpecName(columnName);
  if (PII_NAME.test(norm)) return { tag: "pii", reason: `the name ${columnName} looks like personal data` };
  if (SENSITIVE_PAY.test(norm)) return { tag: "sensitive", reason: `the name ${columnName} looks like pay, banking or health data` };
  if (SENSITIVE_TEXT.test(norm)) return { tag: "sensitive", reason: `the name ${columnName} looks like a credential or free text` };
  const key = opts.key === true || norm === "id" || /_id$/.test(norm);
  if (key) return null;
  const { type, profile } = split(column);
  if (isString(type, profile) && nearUnique(profile, rowCount)) {
    return { tag: "sensitive", reason: `${columnName} has a different value on nearly every row` };
  }
  return null;
}
