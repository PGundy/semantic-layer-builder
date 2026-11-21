import { describe, expect, test } from "bun:test";
import { translateDbtFilter } from "../skills/semantic-layer/scripts/lib/importers/dbt-filters.ts";

const columns: Record<string, string> = {
  order__status: "status",
  order__amount: "amount",
  order__region: "region",
  order__lower_name: "lower(name)",
  a: "a_col",
  "constructor": "x",
};
const D = (n: string): string => `{{ Dimension('${n}') }}`;
const sql = (t: string): string => {
  const r = translateDbtFilter(t, columns);
  if (!("sql" in r)) throw new Error(`skipped: ${r.skipped}`);
  return r.sql;
};
const skipped = (t: string): string => {
  const r = translateDbtFilter(t, columns);
  if (!("skipped" in r)) throw new Error(`translated: ${r.sql}`);
  return r.skipped;
};

describe("translateDbtFilter, supported forms", () => {
  test("a simple filter, a quoted literal and an and-joined filter", () => {
    expect(sql(`${D("order__status")} = 'completed'`)).toBe("status = 'completed'");
    expect(sql(`${D("order__status")} = 'it''s'`)).toBe("status = 'it''s'");
    expect(sql(`${D("order__status")} = 'completed' AND ${D("order__amount")} >= 10.5 And ${D("order__region")} <> 'x'`)).toBe(
      "status = 'completed' and amount >= 10.5 and region <> 'x'",
    );
  });
  test("brace and quote variations", () => {
    expect(sql(`{{Dimension("order__status")}}='a'`)).toBe("status = 'a'");
    expect(sql(`{{\n Dimension (  'order__status'  )\t}} = 'a'`)).toBe("status = 'a'");
  });
  test("each operator and literal form", () => {
    for (const op of ["=", "!=", "<>", "<", "<=", ">", ">="]) expect(sql(`${D("order__amount")} ${op} 3`)).toBe(`amount ${op} 3`);
    expect(sql(`${D("order__amount")} > -2.50`)).toBe("amount > -2.50");
    expect(sql(`${D("order__status")} = TRUE`)).toBe("status = true");
    expect(sql(`${D("order__status")} = false`)).toBe("status = false");
    expect(sql(`${D("order__status")} in ('a', 'b''c', 3)`)).toBe("status in ('a', 'b''c', 3)");
    expect(sql(`${D("order__status")} NOT IN ('a')`)).toBe("status not in ('a')");
    expect(sql(`${D("order__status")} is null`)).toBe("status is null");
    expect(sql(`${D("order__status")} IS  NOT  NULL`)).toBe("status is not null");
    expect(sql(`${D("order__status")} like 'a%'`)).toBe("status like 'a%'");
    expect(sql(`${D("order__status")} not like 'a%'`)).toBe("status not like 'a%'");
  });
  test("column SQL that is not a plain name is wrapped in parentheses", () => {
    expect(sql(`${D("order__lower_name")} = 'x'`)).toBe("(lower(name)) = 'x'");
  });
});

describe("translateDbtFilter, refusals", () => {
  const cases: [string, string, string][] = [
    ["or", `${D("a")} = 1 or ${D("a")} = 2`, "or is not supported"],
    ["parentheses", `(${D("a")} = 1)`, "parentheses"],
    ["a function", `lower(${D("a")}) = 'x'`, "cannot read"],
    ["a cast", `${D("a")}::int = 1`, "cannot read"],
    ["arithmetic", `${D("a")} + 1 = 2`, "cannot read"],
    ["a line comment", `${D("a")} = 1 -- x`, "comments"],
    ["a block comment", `${D("a")} = 1 /* x */`, "comments"],
    ["a semicolon", `${D("a")} = 1;`, "semicolon"],
    ["a second statement", `${D("a")} = 1; select 1`, "semicolon"],
    ["a backslash", `${D("a")} = 1 \\ x`, "backslash"],
    ["a backslash in a string", `${D("a")} = 'a\\b'`, "backslash"],
    ["a dollar-quoted string", `${D("a")} = $$x$$`, "dollar"],
    ["an E string", `${D("a")} = E'x'`, "E''"],
    ["TimeDimension", `{{ TimeDimension('a', 'day') }} = 1`, "TimeDimension"],
    ["Entity", `{{ Entity('a') }} = 1`, "Entity"],
    ["Metric", `{{ Metric('a', group_by=['a']) }} = 1`, "Metric"],
    ["extra arguments", `{{ Dimension('a', entity_path=['b']) }} = 1`, "extra arguments"],
    ["grain", `{{ Dimension('a').grain('day') }} = 1`, "grain"],
    ["a block", `{% if x %}${D("a")} = 1{% endif %}`, "{% %}"],
    ["nested braces", `{{ Dimension('a') }} = {{ x }}`, "braces"],
    ["unbalanced braces", `{{ Dimension('a') = 1`, "cannot read"],
    ["an unterminated string", `${D("a")} = 'abc`, "no closing quote"],
    ["an unknown dimension", `${D("zzz")} = 1`, "not a column"],
    ["an inherited property name", `${D("toString")} = 1`, "not a column"],
    ["an empty filter", "  \n ", "empty"],
    ["null as a value", `${D("a")} = null`, "is null"],
    ["a missing literal", `${D("a")} =`, "ends before"],
    ["a trailing and", `${D("a")} = 1 and`, "ends before"],
    ["a number glued to a word", `${D("a")} = 1and ${D("a")} = 2`, "cannot read"],
    ["an empty in list", `${D("a")} in ()`, "cannot read"],
    ["like with a number", `${D("a")} like 3`, "quoted string"],
  ];
  for (const [name, text, part] of cases)
    test(name, () => {
      expect(skipped(text)).toContain(part);
    });
});

describe("translateDbtFilter, hostile text", () => {
  test("a string that closes a quote and starts a statement stays one string", () => {
    expect(sql(`${D("a")} = '''; drop table x; --'`)).toBe("a_col = '''; drop table x; --'");
    expect(skipped(`${D("a")} = ''; drop table x; --'`)).toContain("semicolon");
  });
  test("a literal holding a placeholder is data", () => {
    expect(sql(`${D("a")} = '{{ Dimension(''a'') }}'`)).toBe("a_col = '{{ Dimension(''a'') }}'");
  });
  test("a literal holding a newline is refused", () => {
    expect(skipped(`${D("a")} = 'x\ny'`)).toContain("line break");
  });
  test("a name holding a quote or a brace is refused", () => {
    expect(skipped(`{{ Dimension('a"b') }} = 1`)).toContain("other than letters");
    expect(skipped(`{{ Dimension('a}}') }} = 1`)).toContain("other than letters");
    expect(skipped(`{{ Dimension("a'b") }} = 1`)).toContain("other than letters");
  });
  test("or after a true-looking term is refused", () => {
    expect(skipped(`1=1 or ${D("a")} = 1`)).toContain("cannot read");
    expect(skipped(`${D("a")} = 1 or 1=1`)).toContain("or is not supported");
  });
  test("unicode quote look-alikes are not quotes", () => {
    expect(skipped(`${D("a")} = ‘x’`)).toContain("cannot read");
    expect(skipped(`{{ Dimension(‘a’) }} = 1`)).toContain("cannot read");
  });
  test("a reason cannot hold a line break and stays short", () => {
    const r = skipped(`${D("a")} = 1 \n\r\u2028 evil\nline ${"x".repeat(500)}`);
    expect(r).not.toMatch(new RegExp("[\\n\\r\\u2028]"));
    expect(r.length).toBeLessThan(200);
  });
  test("column SQL that is itself hostile is refused by the text check", () => {
    for (const col of ["'; drop table x; --", "a; drop table x; --", "a + $1", "a /* x", "a) or (1=1"]) {
      const r = translateDbtFilter(`${D("a")} = 1`, { a: col });
      expect("skipped" in r && r.skipped.startsWith("the column SQL of dimension")).toBe(true);
    }
  });
  test("a long dimension name is shortened in the reason", () => {
    expect(skipped(`{{ Dimension('${"z".repeat(9000)}') }} = 1`).length).toBeLessThan(200);
  });
  test("separators, C1 controls and bidi marks in a string are refused; emoji pass", () => {
    for (const ch of ["\u2028", "\u0085", "\u202e"]) expect(skipped(`${D("a")} = 'x${ch}y'`)).toContain("control character");
    expect(sql(`${D("a")} = 'x😀y'`)).toBe("a_col = 'x😀y'");
  });
  test("a bare dimension is said to need a comparison", () => {
    expect(skipped(D("a"))).toContain("needs a comparison");
  });
  test("near-cap inputs that really parse return quickly", () => {
    const list = `${D("a")} in (${Array(4900).fill("1").join(",")})`;
    for (const t of [list, `${D("a")} = 1`.concat(` and ${D("a")} = 1`.repeat(300))]) {
      const t0 = performance.now();
      translateDbtFilter(t, columns);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
  test("a 100 KB input returns quickly", () => {
    for (const t of [`${D("a")} = '${"x".repeat(100_000)}'`, `${D("a")} = 1 and `.repeat(8000), " ".repeat(100_000) + "x", "'".repeat(100_000)]) {
      const t0 = performance.now();
      expect("skipped" in translateDbtFilter(t, columns)).toBe(true);
      expect(performance.now() - t0).toBeLessThan(250);
    }
  });
});

// A tiny checker that does not share code with the translator: after the column SQL is replaced by a
// marker, the output must be only markers, listed keywords and operators, numbers and strings.
describe("translateDbtFilter, generated filters", () => {
  const cols: Record<string, string> = { d1: "c_one", d2: "lower(c_two)", d3: "t.c_three" };
  const wrapped: Record<string, string> = { d1: "c_one", d2: "(lower(c_two))", d3: "(t.c_three)" };
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)]!;
  const strings = ["a", "it's", "", "x y", "{{ Dimension('d1') }}", "--", "; drop", "100%", "café", "‘q’", "$1", "?"];
  const lit = (): { src: string; value: string } => {
    const k = rnd(4);
    if (k === 0) {
      const v = pick(strings);
      return { src: `'${v.replaceAll("'", "''")}'`, value: `s:${v}` };
    }
    if (k === 1) {
      const v = `${rnd(2) ? "-" : ""}${rnd(1000)}${rnd(2) ? `.${rnd(100)}` : ""}`;
      return { src: v, value: `n:${v}` };
    }
    const v = pick(["true", "false"]);
    return { src: pick([v, v.toUpperCase()]), value: `b:${v}` };
  };
  const ops = ["=", "!=", "<>", "<", "<=", ">", ">="];
  test("output holds only mapped columns, listed operators and the input literals", () => {
    const keywords = new Set(["and", "in", "not", "is", "null", "like", "true", "false"]);
    for (let n = 0; n < 300; n++) {
      const parts: string[] = [];
      const want: string[] = [];
      for (let t = 0, count = 1 + rnd(3); t < count; t++) {
        const d = pick(["d1", "d2", "d3"]);
        const ref = `{{ Dimension('${d}') }}`;
        want.push(`col:${wrapped[d]}`);
        const k = rnd(5);
        if (k === 0 || k === 4) {
          const l = lit();
          parts.push(`${ref} ${pick(ops)} ${l.src}`);
          want.push("op", l.value);
        } else if (k === 1) {
          const items = Array.from({ length: 1 + rnd(3) }, lit);
          parts.push(`${ref} ${rnd(2) ? "not " : ""}in (${items.map((i) => i.src).join(", ")})`);
          want.push("kw", ...items.map((i) => i.value));
        } else if (k === 2) {
          parts.push(`${ref} is ${rnd(2) ? "not " : ""}null`);
          want.push("kw");
        } else {
          const v = pick(strings);
          parts.push(`${ref} like '${v.replaceAll("'", "''")}'`);
          want.push("kw", `s:${v}`);
        }
      }
      const out = translateDbtFilter(parts.join(" and "), cols);
      expect("sql" in out).toBe(true);
      const text = (out as { sql: string }).sql;
      const got: string[] = [];
      const pattern = /\(lower\(c_two\)\)|\(t\.c_three\)|c_one|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|<=|>=|<>|!=|[=<>]|[a-z]+|\(|\)|,|\s+/gy;
      let last = 0;
      for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
        last = pattern.lastIndex;
        const tok = m[0];
        if (/^\s+$/.test(tok) || tok === "(" || tok === ")" || tok === ",") continue;
        if (tok === "(lower(c_two))" || tok === "(t.c_three)" || tok === "c_one") got.push(`col:${tok}`);
        else if (tok.startsWith("'")) got.push(`s:${tok.slice(1, -1).replaceAll("''", "'")}`);
        else if (/^-?\d/.test(tok)) got.push(`n:${tok}`);
        else if (ops.includes(tok)) got.push("op");
        else if (tok === "and") continue;
        else if (tok === "true" || tok === "false") got.push(`b:${tok}`);
        else if (keywords.has(tok)) {
          if (got.at(-1) !== "kw" || tok === "in" || tok === "like" || tok === "null") got.push("kw");
        } else throw new Error(`unexpected token ${tok} in ${text}`);
      }
      expect(last).toBe(text.length);
      // not/is/not null collapse into one marker per term, so compare with repeats removed.
      const squash = (xs: string[]): string[] => xs.filter((x, i) => !(x === "kw" && xs[i - 1] === "kw"));
      expect(squash(got)).toEqual(squash(want));
    }
  });
});
