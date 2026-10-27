import { describe, expect, test } from "bun:test";
import { conditionAttributes, evaluateCondition, parseCondition } from "../skills/semantic-layer/scripts/lib/conditions.ts";

const ev = (src: string, user: Record<string, unknown>) => evaluateCondition(parseCondition(src), user);

describe("conditions", () => {
  test("comparisons, booleans and numbers", () => {
    expect(ev("user.department == 'finance'", { department: "finance" })).toBe(true);
    expect(ev("user.level >= 5", { level: 5 })).toBe(true);
    expect(ev("user.level > 5", { level: 5 })).toBe(false);
    expect(ev("user.is_manager == true", { is_manager: true })).toBe(true);
    expect(ev("user.level >= 5", { level: "7" })).toBe(false);
  });

  test("and, or, not, parentheses", () => {
    const c = "user.department == 'finance' and (user.level >= 5 or user.is_manager == true)";
    expect(ev(c, { department: "finance", level: 3, is_manager: true })).toBe(true);
    expect(ev(c, { department: "finance", level: 3, is_manager: false })).toBe(false);
    expect(ev("not user.department == 'hr'", { department: "sales" })).toBe(true);
  });

  test("in, not in, contains and lists", () => {
    expect(ev("user.region in ['NE', 'SE']", { region: "NE" })).toBe(true);
    expect(ev("user.region not in ['NE', 'SE']", { region: "MW" })).toBe(true);
    expect(ev("user.regions in ['NE']", { regions: ["MW", "NE"] })).toBe(true);
    expect(ev("user.groups contains 'finance'", { groups: ["finance", "all"] })).toBe(true);
    expect(ev("user.groups contains 'finance'", { groups: "finance" })).toBe(false);
  });

  test("missing attributes fail closed except is set", () => {
    expect(ev("user.level >= 5", {})).toBe(false);
    expect(ev("user.region != 'NE'", {})).toBe(false);
    expect(ev("user.region in ['NE']", {})).toBe(false);
    expect(ev("user.region not in ['NE']", {})).toBe(false);
    expect(ev("user.region is set", {})).toBe(false);
    expect(ev("user.region is not set", {})).toBe(true);
  });

  test("quotes escape and attributes are listed", () => {
    expect(ev("user.name == 'O''Brien'", { name: "O'Brien" })).toBe(true);
    expect(conditionAttributes(parseCondition("user.b == 1 or (user.a in [1] and not user.b is set)"))).toEqual(["a", "b"]);
  });

  test.each(["", "department == 'x'", "user.level >= ", "user.level = 5", "user.a == 'x' and", "user.a in 'x'", "(user.a == 1", "user.a == 1 user.b == 2", "user.a == drop"])(
    "rejects %p",
    (src) => {
      expect(() => parseCondition(src)).toThrow("Invalid condition");
    },
  );
});
