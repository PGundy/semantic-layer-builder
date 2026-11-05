// Name and profile heuristics for columns whose values look personal or sensitive. sl draft tags
// the fields it drafts from them, and sl validate warns when an approved field everyone may see
// matches one without a pii, sensitive or public tag.
import { classifyType, isTemporal } from "./column-types.ts";
import { toSpecName } from "./naming.ts";
import type { ColumnProfile, SnapshotColumn } from "./types.ts";

export type SensitivityTag = "pii" | "sensitive";

export interface Sensitivity {
  tag: SensitivityTag;
  reason: string;
}

// Nouns for a person: <noun>_name (customer_name, owners_name) is a person's name, and
// <noun>_number, <noun>_ref and <noun>_code (customer_number, member_ref) identify one.
const PERSON_NOUNS = ["customer", "user", "contact", "employee", "owner", "member", "patient", "person", "recipient", "sender"];
// Words that name a person's name with the word name: given_name, surname, billing_name.
const NAME_WORDS = ["first", "last", "middle", "full", "given", "family", "maiden", "legal", "preferred", "sur", "nick", "billing", "shipping", "cardholder", "account_holder"];

// Personal data by name. Underscores between words are optional, so the forms an unquoted
// CamelCase identifier folds to (FirstName as firstname in Postgres, FIRSTNAME in Snowflake) match
// like first_name. Most words match from the start of a snake_case word on, so home_address,
// email_hash and customer_name_upper match; <noun>_name and <word>_name end at a word boundary, so
// user_namespace does not. A bare name or names, an ip column (ip, client_ip, ipv4) and a login
// (login, user_login, login_name) match only as the whole name or its last word, so name_length,
// ip_country and last_login_at do not. A display_name or displayname matches only as the whole
// name's start (product_display_name is a product's).
export const PII_NAME = new RegExp(
  "(^|_)(email|phone|mobile|ssn|social_?security|address|street|postal|zip|" +
    "birth|dob|ip_?address|passport|tax_?id|tax_?number|user_?agent|device_?id|" +
    "drivers?_?licen[cs]e|licen[cs]e_?(number|num|no)|national_?insurance|social_?insurance|insurance_?number|nhs_?number)" +
    `|(^|_)(${PERSON_NOUNS.join("|")})s?_?names?(_|$)` +
    `|(^|_)(${NAME_WORDS.join("|")})_?names?(_|$)` +
    "|^display_?names?(_|$)" +
    `|(^|_)(${[...PERSON_NOUNS, "student"].join("|")})s?_?(number|num|no|ref|code)s?(_|$)` +
    "|^names?$|(^|_)(ip|ipv4|ipv6|ip_?addr|login|login_?name)$",
);
// A login as the name's last word: a date or time column named so (last_login) holds when, not who.
const LOGIN_LAST = /(^|_)login$/;

// Code-like names (sku, code, *_code, *_number, *_ref, slug): business identifiers that are
// near-unique without being personal, so the near-unique rule skips them.
const CODE_LIKE = /(^|_)(sku|code|number|ref|slug)s?$/;

// Whether a column's name is code-like (CODE_LIKE), which exempts it from the near-unique rule.
export function codeLike(columnName: string): boolean {
  return CODE_LIKE.test(toSpecName(columnName));
}

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
const SENSITIVE_TEXT = wordsPattern([
  "password",
  "passcode",
  "secret",
  "token",
  "api_key",
  "otp",
  "pin",
  "auth_code",
  "verification_code",
  "access_code",
  "reset_code",
  "invite_code",
  "session_ref",
  "session_key",
  "notes",
  "note",
  "comment",
  "comments",
  "message",
  "free_text",
  "body",
  "reason_text",
]);

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
// health, credential or free-text word, whatever the column's type (except a date or time column
// named for a login) and whether or not it is a key,
// or when a string column that is not a key and not code-like (CODE_LIKE) is near-unique; null
// otherwise. The rules are a heuristic: a column they miss is protected only once it is tagged.
export function sensitivityOf(
  columnName: string,
  column?: SensitivityColumn,
  rowCount?: number | null,
  opts: SensitivityOptions = {},
): Sensitivity | null {
  const norm = toSpecName(columnName);
  const { type, profile } = split(column);
  // A date or time column whose name ends in login is tested without that word.
  const personal = type !== undefined && isTemporal(classifyType(type)) && LOGIN_LAST.test(norm) ? norm.replace(LOGIN_LAST, "") : norm;
  if (personal && PII_NAME.test(personal)) return { tag: "pii", reason: `the name ${columnName} looks like personal data` };
  if (SENSITIVE_PAY.test(norm)) return { tag: "sensitive", reason: `the name ${columnName} looks like pay, banking or health data` };
  if (SENSITIVE_TEXT.test(norm)) return { tag: "sensitive", reason: `the name ${columnName} looks like a credential or free text` };
  const key = opts.key === true || norm === "id" || /_id$/.test(norm);
  if (key || codeLike(columnName)) return null;
  if (isString(type, profile) && nearUnique(profile, rowCount)) {
    return { tag: "sensitive", reason: `${columnName} has a different value on nearly every row` };
  }
  return null;
}
