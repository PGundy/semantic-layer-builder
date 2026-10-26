import { expect, test } from "bun:test";
import { classifyType } from "../skills/semantic-layer/scripts/lib/column-types.ts";

test.each([
  ["BIGINT", "integer"],
  ["integer", "integer"],
  ["NUMBER(38,0)", "integer"],
  ["NUMBER(10,2)", "decimal"],
  ["numeric", "decimal"],
  ["DECIMAL(18, 4)", "decimal"],
  ["double precision", "decimal"],
  ["FLOAT64", "decimal"],
  ["DATE", "date"],
  ["timestamp with time zone", "timestamp"],
  ["TIMESTAMP_NTZ(9)", "timestamp"],
  ["DATETIME", "timestamp"],
  ["character varying(255)", "string"],
  ["STRING", "string"],
  ["uuid", "string"],
  ["BOOLEAN", "boolean"],
  ["jsonb", "other"],
  ["INTEGER[]", "other"],
  ["ARRAY<STRING>", "other"],
  ["STRUCT<a INT>", "other"],
])("%s is %s", (raw, cat) => {
  expect(classifyType(raw)).toBe(cat as ReturnType<typeof classifyType>);
});
