import type { DocRule } from "./index.ts";

// The metric-semantics rules the docs keep (workstream C): one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "weeks start on Monday unless the source sets another day", "A source's weeks start on Monday unless its file sets another day"],
  ["spec.md", "the week start takes the seven day names only", "`calendar.week_start` takes the seven day names in lower case and nothing else"],
  ["spec.md", "unset or monday compiles as before", "Unset, or `monday`, it compiles to `cast(date_trunc('week', <expr>) as date)` as before"],
  ["spec.md", "a new week start sends week dimensions back, and why", "because the weeks the owner approved are not the weeks it now gives"],
  ["spec.md", "an unset calendar hashes as before", "A source without `calendar`, or with `monday`, hashes every dimension as before"],
  ["spec.md", "a default time dimension is a time dimension of its model", "names a `type: time` dimension of the same model"],
  ["spec.md", "the bare grain reads the first measure's default", "is the default time dimension of the request's first measure at that grain"],
  ["spec.md", "no default is refused with its code", "is refused as `metric.default_time_missing`"],
  ["spec.md", "a balance is not added up across time", "A balance is not added up across time"],
  ["spec.md", "row filters apply before a balance row is kept", "gets the last balance of the rows they may see"],
  ["spec.md", "a mixed balance request is refused with its code", "is refused as `metric.semi_additive_mixed`"],
  ["spec.md", "the readback figure uses the balance rule", "are computed by the same rule, over the kept rows"],
  ["phases/metrics.md", "the metrics card asks whether a figure is a level", "Is this the amount at the end of each period, or at its start?"],
  ["phases/metrics.md", "the metrics card asks the week start and the date", "Which day does your week start on, and which date is each of these figures counted by"],
  ["phases/metrics.md", "the week start is written by setup", "--week-start <day>"],
];
