import { describe, expect, test } from "bun:test";
import { nearUnique, sensitivityOf } from "../skills/semantic-layer/scripts/lib/sensitivity.ts";

const str = (distinct?: number) => ({ type: "varchar", ...(distinct === undefined ? {} : { profile: { distinct_count: distinct } }) });
const int = { type: "integer" };

describe("sensitivityOf by name", () => {
  test("personal data names are pii, keys included", () => {
    for (const name of ["email", "customer_email", "phone", "home_address", "zip_code", "first_name", "date_of_birth", "dob", "ssn", "ip_address", "tax_id"]) {
      expect(sensitivityOf(name, str(), 100)).toEqual({ tag: "pii", reason: `the name ${name} looks like personal data` });
    }
    // A key named for personal data is still pii, as the draft has always tagged it.
    expect(sensitivityOf("address_id", int, 100)?.tag).toBe("pii");
    expect(sensitivityOf("email", str(), 100, { key: true })?.tag).toBe("pii");
    // Camel case reads as snake case.
    expect(sensitivityOf("CustomerEmail", str(), 100)?.tag).toBe("pii");
  });

  test("pay, banking, card and health names are sensitive whatever the type", () => {
    for (const [name, col] of [
      ["salary", int],
      ["base_salary", { type: "decimal(12,2)" }],
      ["compensation", int],
      ["comp", int],
      ["comp_band", str()],
      ["hourly_wage", int],
      ["bonus_amount", int],
      ["bonuses", int],
      ["payroll_run", str()],
      ["bank_name", str()],
      ["iban", str()],
      ["account_number", str()],
      ["routing_number", str()],
      ["card_last4", str()],
      ["health_score", int],
      ["medical_flag", { type: "boolean" }],
      ["diagnosis", str()],
      ["salaries", int],
      ["annual_salaries", int],
      ["diagnoses", str()],
      ["wages", int],
    ] as const) {
      expect(sensitivityOf(name, col, 100)).toEqual({ tag: "sensitive", reason: `the name ${name} looks like pay, banking or health data` });
    }
  });

  test("credential and free-text names are sensitive whatever the type", () => {
    for (const name of ["password_hash", "secret", "api_key", "token", "notes", "note", "comment", "comments", "message", "free_text", "body", "bodies", "reason_text", "internal_notes"]) {
      expect(sensitivityOf(name, str(), 100)).toEqual({ tag: "sensitive", reason: `the name ${name} looks like a credential or free text` });
    }
    // The name list has no type condition, so a numeric column with one of the words is sensitive too.
    expect(sensitivityOf("comment_count", int, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("token_count", { type: "bigint" }, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("messages", { type: "double" }, 100)?.tag).toBe("sensitive");
    // With no type known, the name decides.
    expect(sensitivityOf("notes", undefined, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("notes", { distinct_count: 3 }, 100)?.tag).toBe("sensitive");
  });

  test("names match whole snake_case words only", () => {
    for (const name of ["discard_flag", "compass", "competitor", "notebook", "bodyweight", "cardinality", "messaging_channel_type", "secretariat", "tokenized_flag", "status", "region"]) {
      expect(sensitivityOf(name, str(5), 100)).toBeNull();
    }
  });

  test("keys are sensitive by name but never by profile", () => {
    expect(sensitivityOf("card_id", int, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("diagnosis_id", int, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("payroll_id", int, 100, { key: true })?.tag).toBe("sensitive");
    expect(sensitivityOf("message_id", str(100), 100)?.tag).toBe("sensitive");
    // Near-unique keys are not sensitive.
    expect(sensitivityOf("id", str(100), 100)).toBeNull();
    expect(sensitivityOf("order_id", str(100), 100)).toBeNull();
    expect(sensitivityOf("order_ref", str(100), 100, { key: true })).toBeNull();
  });
});

describe("sensitivityOf by profile", () => {
  test("a near-unique string column that is not a key is sensitive", () => {
    expect(sensitivityOf("tracking_code", str(990), 1000)).toEqual({ tag: "sensitive", reason: "tracking_code has a different value on nearly every row" });
    expect(sensitivityOf("tracking_code", { type: "text", profile: { distinct_count: 50 } }, 50)?.tag).toBe("sensitive");
  });

  test("small tables, a ratio of 0.9 or less, numbers and unprofiled columns are not", () => {
    expect(sensitivityOf("tracking_code", str(49), 49)).toBeNull();
    expect(sensitivityOf("tracking_code", str(900), 1000)).toBeNull();
    expect(sensitivityOf("weight_kg", { type: "double", profile: { distinct_count: 1000 } }, 1000)).toBeNull();
    expect(sensitivityOf("tracking_code", str(), 1000)).toBeNull();
    expect(sensitivityOf("tracking_code", str(990), null)).toBeNull();
    expect(sensitivityOf("tracking_code", str(990), undefined)).toBeNull();
  });

  test("a bare profile counts as a string column when its values are strings", () => {
    const profile = { distinct_count: 99, top_values: [{ value: "a1", count: 1 }], min: "a0", max: "z9" };
    expect(sensitivityOf("tracking_code", profile, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("amount", { distinct_count: 99, min: 1, max: 100 }, 100)).toBeNull();
    expect(sensitivityOf("tracking_code", { distinct_count: 99 }, 100)).toBeNull();
    expect(sensitivityOf("tracking_code", null, 100)).toBeNull();
  });

  test("nearUnique needs at least 50 rows and more than 90% distinct", () => {
    expect(nearUnique({ distinct_count: 46 }, 50)).toBe(true);
    expect(nearUnique({ distinct_count: 45 }, 50)).toBe(false);
    expect(nearUnique({ distinct_count: 49 }, 49)).toBe(false);
    expect(nearUnique({}, 100)).toBe(false);
    expect(nearUnique(undefined, 100)).toBe(false);
  });
});
