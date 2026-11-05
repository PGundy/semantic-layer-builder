import { describe, expect, test } from "bun:test";
import { codeLike, nearUnique, sensitivityOf } from "../skills/semantic-layer/scripts/lib/sensitivity.ts";

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

  test("person names, logins, ip addresses, user agents and device ids are pii", () => {
    for (const name of [
      "name",
      "names",
      "full_name",
      "first_name",
      "last_name",
      "middle_name",
      "customer_name",
      "user_name",
      "contact_name",
      "employee_name",
      "owner_name",
      "member_name",
      "patient_name",
      "person_name",
      "recipient_name",
      "sender_name",
      "billing_customer_name",
      "CustomerName",
      "username",
      "login",
      "user_login",
      "login_name",
      "ip",
      "client_ip",
      "ipv4",
      "ip_address",
      "user_agent",
      "device_id",
    ]) {
      expect(sensitivityOf(name, str(3), 100)).toEqual({ tag: "pii", reason: `the name ${name} looks like personal data` });
    }
    // device_id is a key name, and still pii.
    expect(sensitivityOf("device_id", int, 100, { key: true })?.tag).toBe("pii");
  });

  test("reviewer reproduction: person-name and identifier names without underscores are pii, as unquoted CamelCase folds them", () => {
    for (const name of [
      "firstname",
      "lastname",
      "fullname",
      "middlename",
      "customername",
      "useragent",
      "deviceid",
      "ipaddress",
      "FIRSTNAME",
      "CUSTOMERNAME",
      "USERAGENT",
      "FirstName",
      "given_name",
      "givenname",
      "surname",
      "family_name",
      "maiden_name",
      "display_name",
      "nickname",
      "billing_name",
      "cardholder_name",
      "usernames",
    ]) {
      // Values that repeat (20 distinct of 100), so only the name can protect the column.
      expect(sensitivityOf(name, { type: "text", profile: { distinct_count: 20 } }, 100)).toEqual({ tag: "pii", reason: `the name ${name} looks like personal data` });
    }
  });

  test("reviewer reproduction: personal numbers and references are pii, and one-time codes are sensitive, ahead of the code-like exemption", () => {
    for (const name of [
      "license_number",
      "licence_no",
      "drivers_license_number",
      "driver_licence",
      "national_insurance_number",
      "social_insurance_number",
      "insurance_number",
      "nhs_number",
      "tax_number",
      "customer_number",
      "member_number",
      "employee_number",
      "patient_ref",
      "student_number",
      "customer_ref",
      "user_code",
    ]) {
      expect(sensitivityOf(name, str(100), 100)).toEqual({ tag: "pii", reason: `the name ${name} looks like personal data` });
    }
    for (const name of ["otp", "otp_code", "pin", "passcode", "auth_code", "verification_code", "access_code", "reset_code", "invite_code", "session_ref", "session_key"]) {
      expect(sensitivityOf(name, str(100), 100)).toEqual({ tag: "sensitive", reason: `the name ${name} looks like a credential or free text` });
    }
  });

  test("a date or time column named for a login is not pii; a text one is", () => {
    expect(sensitivityOf("last_login", { type: "timestamp" }, 100)).toBeNull();
    expect(sensitivityOf("login", { type: "date" }, 100)).toBeNull();
    expect(sensitivityOf("last_login", { type: "timestamptz" }, 100)).toBeNull();
    expect(sensitivityOf("last_login", str(3), 100)?.tag).toBe("pii");
    expect(sensitivityOf("login", undefined, 100)?.tag).toBe("pii");
    // Another personal word in the name still counts.
    expect(sensitivityOf("email_login", { type: "timestamp" }, 100)?.tag).toBe("pii");
  });

  test("other name and ip words are not person names", () => {
    for (const name of [
      "product_name",
      "store_name",
      "shop_name",
      "category_name",
      "name_length",
      "ip_country",
      "ipsum",
      "vip_tier",
      "last_login_at",
      "login_count",
      "shipment",
      "tip",
      // Reviewer reproduction: a person noun followed by a word that only starts with name.
      "user_namespace",
      "member_named_x",
      "product_display_name",
      "filename",
      "hostname",
      "pinned",
      "spin_rate",
    ]) {
      expect(sensitivityOf(name, str(5), 100)).toBeNull();
    }
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
    expect(sensitivityOf("visitor_handle", str(990), 1000)).toEqual({ tag: "sensitive", reason: "visitor_handle has a different value on nearly every row" });
    expect(sensitivityOf("visitor_handle", { type: "text", profile: { distinct_count: 50 } }, 50)?.tag).toBe("sensitive");
  });

  test("code-like columns are exempt from the near-unique rule", () => {
    for (const name of ["sku", "product_sku", "code", "promo_code", "order_number", "invoice_number", "order_ref", "slug", "skus"]) {
      expect(sensitivityOf(name, str(1000), 1000)).toBeNull();
    }
    // The name rules still come first: a phone_number or an account_number stays protected.
    expect(sensitivityOf("phone_number", str(1000), 1000)?.tag).toBe("pii");
    expect(sensitivityOf("account_number", str(1000), 1000)?.tag).toBe("sensitive");
    expect(sensitivityOf("zip_code", str(1000), 1000)?.tag).toBe("pii");
    expect(codeLike("ProductSku")).toBe(true);
    expect(codeLike("coupon_code")).toBe(true);
    expect(codeLike("visitor_handle")).toBe(false);
    // A name that only contains a code word is not exempt.
    expect(sensitivityOf("code_reviewer", str(1000), 1000)?.tag).toBe("sensitive");
  });

  test("small tables, a ratio of 0.9 or less, numbers and unprofiled columns are not", () => {
    expect(sensitivityOf("visitor_handle", str(49), 49)).toBeNull();
    expect(sensitivityOf("visitor_handle", str(900), 1000)).toBeNull();
    expect(sensitivityOf("weight_kg", { type: "double", profile: { distinct_count: 1000 } }, 1000)).toBeNull();
    expect(sensitivityOf("visitor_handle", str(), 1000)).toBeNull();
    expect(sensitivityOf("visitor_handle", str(990), null)).toBeNull();
    expect(sensitivityOf("visitor_handle", str(990), undefined)).toBeNull();
  });

  test("a bare profile counts as a string column when its values are strings", () => {
    const profile = { distinct_count: 99, top_values: [{ value: "a1", count: 1 }], min: "a0", max: "z9" };
    expect(sensitivityOf("visitor_handle", profile, 100)?.tag).toBe("sensitive");
    expect(sensitivityOf("amount", { distinct_count: 99, min: 1, max: 100 }, 100)).toBeNull();
    expect(sensitivityOf("visitor_handle", { distinct_count: 99 }, 100)).toBeNull();
    expect(sensitivityOf("visitor_handle", null, 100)).toBeNull();
  });

  test("nearUnique needs at least 50 rows and more than 90% distinct", () => {
    expect(nearUnique({ distinct_count: 46 }, 50)).toBe(true);
    expect(nearUnique({ distinct_count: 45 }, 50)).toBe(false);
    expect(nearUnique({ distinct_count: 49 }, 49)).toBe(false);
    expect(nearUnique({}, 100)).toBe(false);
    expect(nearUnique(undefined, 100)).toBe(false);
  });
});
