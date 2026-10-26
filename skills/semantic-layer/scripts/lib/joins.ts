// Turns a join-check result row into evidence, findings and a plain-English sentence.
import { UserError } from "./errors.ts";
import type { JoinEvidence, JoinKey, Relationship } from "./types.ts";

export type SuggestedRelationship = JoinEvidence["suggested_relationship"];

export interface JoinFinding {
  level: "warn" | "info";
  message: string;
}

export interface JoinEvaluation {
  evidence: JoinEvidence;
  // False when one side has no rows with a complete key, so uniqueness and the
  // suggested relationship were not measured and the evidence must not be stored.
  measured: boolean;
  findings: JoinFinding[];
  sentence: string;
}

export interface EvaluateOptions {
  // Model names used in the sentence and findings, e.g. "orders" and "customers".
  left?: string;
  right?: string;
  // ISO timestamp for evidence.checked_at; callers pass the command clock.
  checkedAt?: string;
  // The join's target model and keys as declared, recorded in the evidence when given.
  to?: string;
  keys?: JoinKey[];
}

// A non-negative integer count from a result row; a missing or null value is an error, never 0.
function count(row: Record<string, unknown>, key: string): number {
  const v = row[key];
  if (v === undefined || v === null) throw new UserError(`Join check result is missing ${key}.`);
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new UserError(`Join check result has an invalid ${key}: ${typeof v === "bigint" ? v.toString() : JSON.stringify(v)}.`);
  }
  return n;
}

function requireAtMost(a: number, aKey: string, b: number, bKey: string): void {
  if (a > b) throw new UserError(`Join check result is inconsistent: ${aKey} (${a}) is more than ${bKey} (${b}).`);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function suggestRelationship(leftUnique: boolean, rightUnique: boolean): SuggestedRelationship {
  if (leftUnique && rightUnique) return "one_to_one";
  if (rightUnique) return "many_to_one";
  if (leftUnique) return "one_to_many";
  return "many_to_many";
}

// Irregular plurals, singular to plural.
const IRREGULAR: Record<string, string> = {
  person: "people",
  child: "children",
  man: "men",
  woman: "women",
  mouse: "mice",
  goose: "geese",
  foot: "feet",
  tooth: "teeth",
};
const IRREGULAR_PLURAL: Record<string, string> = Object.fromEntries(Object.entries(IRREGULAR).map(([one, many]) => [many, one]));

// Singular and plural phrases for a model name: "order_items" -> "order item" / "order items".
// Only the last word is inflected: "sales_people" -> "sales person" / "sales people".
export function nounForms(name: string): { one: string; many: string } {
  const words = name.replace(/_+/g, " ").trim() || name;
  const space = words.lastIndexOf(" ");
  const head = space >= 0 ? words.slice(0, space + 1) : "";
  const last = words.slice(space + 1);
  const lower = last.toLowerCase();
  const irregularOne = IRREGULAR_PLURAL[lower] ?? (IRREGULAR[lower] ? lower : undefined);
  if (irregularOne) return { one: head + irregularOne, many: head + IRREGULAR[irregularOne]! };
  let one = last;
  if (/ies$/.test(last)) one = last.replace(/ies$/, "y");
  else if (/(ss|us|is)$/.test(last)) one = last;
  else if (/(x|ch|sh|ss)es$/.test(last)) one = last.replace(/es$/, "");
  else if (/s$/.test(last)) one = last.replace(/s$/, "");
  let many: string;
  if (/[^aeiou]y$/.test(one)) many = one.replace(/y$/, "ies");
  else if (/(s|x|ch|sh)$/.test(one)) many = `${one}es`;
  else many = `${one}s`;
  return { one: head + one, many: head + many };
}

function n(x: number): string {
  return x.toLocaleString("en-US");
}

// A percentage that never reads 100% while rows are missing, nor 0% while some match.
export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  let p = Math.round((part / whole) * 1000) / 10;
  if (p === 100 && part < whole) p = 99.9;
  if (p === 0 && part > 0) p = 0.1;
  return `${p}%`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export function evaluateJoin(
  row: Record<string, unknown>,
  yamlRelationship: Relationship | undefined,
  opts: EvaluateOptions = {},
): JoinEvaluation {
  const leftRows = count(row, "left_rows");
  const leftNull = count(row, "left_null_keys");
  const matched = count(row, "matched_rows");
  const rightRows = count(row, "right_rows");
  const rightDistinct = count(row, "right_distinct_keys");
  const rightMaxDup = count(row, "right_max_dup");
  const leftDistinct = count(row, "left_distinct_keys");
  const leftMaxDup = count(row, "left_max_dup");
  requireAtMost(matched + leftNull, "matched_rows + left_null_keys", leftRows, "left_rows");
  requireAtMost(leftDistinct, "left_distinct_keys", leftRows - leftNull, "left rows with a key");
  requireAtMost(leftMaxDup, "left_max_dup", leftRows - leftNull, "left rows with a key");
  requireAtMost(rightDistinct, "right_distinct_keys", rightRows, "right_rows");
  requireAtMost(rightMaxDup, "right_max_dup", rightRows, "right_rows");
  if ((leftDistinct === 0) !== (leftMaxDup === 0)) {
    throw new UserError(`Join check result is inconsistent: left_distinct_keys is ${leftDistinct} but left_max_dup is ${leftMaxDup}.`);
  }
  if ((rightDistinct === 0) !== (rightMaxDup === 0)) {
    throw new UserError(`Join check result is inconsistent: right_distinct_keys is ${rightDistinct} but right_max_dup is ${rightMaxDup}.`);
  }
  if (matched > 0 && rightDistinct === 0) {
    throw new UserError(`Join check result is inconsistent: matched_rows is ${matched} but the right side has no keys.`);
  }

  const rightUnique = rightMaxDup <= 1;
  const leftUnique = leftMaxDup <= 1;
  const suggested = suggestRelationship(leftUnique, rightUnique);
  const evidence: JoinEvidence = {
    checked_at: opts.checkedAt ?? new Date().toISOString(),
    ...(opts.to !== undefined ? { to: opts.to } : {}),
    ...(opts.keys !== undefined ? { keys: opts.keys.map((k) => ({ from: k.from, to: k.to })) } : {}),
    left_rows: leftRows,
    left_null_keys: leftNull,
    matched_rows: matched,
    match_rate: leftRows > 0 ? round4(matched / leftRows) : 0,
    right_rows: rightRows,
    right_key_unique: rightUnique,
    left_key_unique: leftUnique,
    max_fanout: rightMaxDup,
    suggested_relationship: suggested,
  };

  const L = nounForms(opts.left ?? "left row");
  const R = nounForms(opts.right ?? "right row");
  const unmatched = Math.max(0, leftRows - matched);
  const findings: JoinFinding[] = [];

  // Uniqueness is only measured when both sides have at least one complete key.
  const measured = leftDistinct > 0 && rightDistinct > 0;
  if (leftRows === 0) {
    findings.push({ level: "warn", message: `The ${L.many} table has no rows, so this join could not be measured.` });
    return { evidence, measured, findings, sentence: `There are no ${L.many} to check, so this join could not be measured.` };
  }
  if (leftDistinct === 0) {
    findings.push({
      level: "warn",
      message: `Every ${L.one} has an empty join key, so no ${L.one} can join and this join could not be measured.`,
    });
    return {
      evidence,
      measured,
      findings,
      sentence: `None of the ${n(leftRows)} ${L.many} has a join key, so this join could not be measured.`,
    };
  }
  if (rightDistinct === 0) {
    findings.push({
      level: "warn",
      message:
        rightRows === 0
          ? `The ${R.many} table has no rows, so no ${L.one} finds ${article(R.one)} ${R.one} and this join could not be measured.`
          : `Every ${R.one} has an empty join key, so no ${L.one} finds ${article(R.one)} ${R.one} and this join could not be measured.`,
    });
    if (leftNull > 0) findings.push(nullFinding(leftNull, L));
    return {
      evidence,
      measured,
      findings,
      sentence: `No ${L.one} finds ${article(R.one)} ${R.one}, because the ${R.many} have no join keys, so this join could not be measured.`,
    };
  }

  if (unmatched > 0) {
    findings.push({
      level: "warn",
      message: `Match rate is ${pct(matched, leftRows)}: ${n(unmatched)} of ${n(leftRows)} ${L.many} find no ${R.one}.`,
    });
  }
  if (leftNull > 0) findings.push(nullFinding(leftNull, L));
  if (yamlRelationship === undefined) {
    findings.push({ level: "warn", message: `The YAML gives this join no relationship; the data says ${suggested}.` });
  } else if (yamlRelationship !== suggested) {
    findings.push({ level: "warn", message: `The YAML says ${yamlRelationship}, but the data says ${suggested}.` });
  }
  if (suggested === "many_to_many") {
    findings.push({
      level: "warn",
      message: `Neither side is unique on the join key (up to ${n(leftMaxDup)} ${L.many} and ${n(rightMaxDup)} ${R.many} share one key). It cannot be joined directly: it needs a bridge table or a pre-aggregated model.`,
    });
  } else if (suggested === "one_to_many") {
    findings.push({
      level: "warn",
      message: `Each ${L.one} can match up to ${n(rightMaxDup)} ${rightMaxDup === 1 ? R.one : R.many}, so this join fans out: ${L.one} measures would be multiplied unless the ${R.one} side is aggregated first.`,
    });
  }

  return { evidence, measured, findings, sentence: sentence(evidence, leftMaxDup, L, R) };
}

function nullFinding(leftNull: number, L: { one: string; many: string }): JoinFinding {
  return {
    level: "warn",
    message: `${n(leftNull)} ${leftNull === 1 ? L.one : L.many} ${leftNull === 1 ? "has" : "have"} an empty join key, so ${leftNull === 1 ? "it never joins" : "they never join"}.`,
  };
}

function sentence(
  e: JoinEvidence,
  leftMaxDup: number,
  L: { one: string; many: string },
  R: { one: string; many: string },
): string {
  const unmatched = e.left_rows - e.matched_rows;
  const coverage =
    unmatched === 0
      ? `every ${L.one} finds ${e.suggested_relationship === "one_to_many" || e.suggested_relationship === "many_to_many" ? `at least one ${R.one}` : `its ${R.one}`}`
      : e.matched_rows === 0
        ? `no ${L.one} finds ${article(R.one)} ${R.one}`
        : `${pct(e.matched_rows, e.left_rows)} of ${L.many} find ${e.suggested_relationship === "many_to_one" || e.suggested_relationship === "one_to_one" ? `their ${R.one}` : `${article(R.one)} ${R.one}`} (${n(unmatched)} ${unmatched === 1 ? "does" : "do"} not)`;
  switch (e.suggested_relationship) {
    case "many_to_one":
      return `Each ${L.one} points to at most one ${R.one}, and ${coverage}.`;
    case "one_to_one":
      return `Each ${L.one} matches at most one ${R.one} and each ${R.one} at most one ${L.one}, and ${coverage}.`;
    case "one_to_many":
      return `Each ${L.one} can match up to ${n(e.max_fanout)} ${e.max_fanout === 1 ? R.one : R.many}, so ${L.one} totals would be multiplied across this join, and ${coverage}.`;
    case "many_to_many":
      return `Up to ${n(leftMaxDup)} ${L.many} and up to ${n(e.max_fanout)} ${R.many} share the same key, so this join needs a bridge table, and ${coverage}.`;
  }
}
