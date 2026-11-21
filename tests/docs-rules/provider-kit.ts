import type { DocRule } from "./index.ts";

// The provider-kit rules the docs keep (workstream F, F5): one phrase per rule.
export const RULES: DocRule[] = [
  ["spec.md", "the version is computed, not the server's text", "computed from `server_version_num`, never the server's own text"],
  ["spec.md", "tls is read from the server's view of the session", "`tls` is `true` or `false` from `pg_stat_ssl` for `pg_backend_pid()`"],
  ["spec.md", "the pooler line is a guess and changes nothing", "`pooled` is a guess and the text says so"],
  ["spec.md", "the fixture is built from an allowlist and fails closed", "The fixture is built from that list, not scrubbed from the output, and the script writes nothing when it still holds a part of the URL, an address or a URL"],
  ["spec.md", "doctor's new keys are null without a postgres source", "are `null` when none did, as for a DuckDB source"],
];
