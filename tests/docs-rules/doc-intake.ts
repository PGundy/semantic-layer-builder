import type { DocRule } from "./index.ts";

// The procedure rules references/intake.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["intake.md", "lake discovery with the agent's own tools", "list its files with your own file tools, or ask the owner for the listing"],
  ["intake.md", "changing views later", "rerun `semlayer introspect --source <source>`"],
  ["intake.md", "views have no row count until profile", "semlayer profile measures them."],
  ["intake.md", "time zones", "session time zone UTC"],
  // Sources and scope.
  ["intake.md", "one view per dataset, noise included", "Make one view per dataset, including the ones that look like noise"],
  ["intake.md", "duckdb views live in main", "live in schema `main`"],
  ["intake.md", "validate catches credentials in duckdb connections", "naming the key and never the value"],
  ["intake.md", "no source holds an aggregate view", "a view there is one table expression, so an aggregate or a subquery is refused"],
  // Synonyms, engineering asks, rule goldens, access open questions, handoff and resume.
  ["intake.md", "engineering only when no construct expresses the rule", "Ask engineering for one only when no supported construct (a join reference within two hops, or a filter that writes the rule out) can express the rule"],
  // Keeping the layer current.
  ["intake.md", "a rerun prints the changes", "A rerun prints what changed since the previous snapshot"],
  // Scope, profiles, new columns, pair tables.
  ["intake.md", "introspect's next hint", "`semlayer status` while approved models have left scope; else `semlayer profile --source <s>` while some in-scope table is not fully profiled; else `semlayer validate` when a modeled table changed; else `semlayer draft --source <s> --tables <t>` for tables new in scope with no model; else `semlayer status`"],
  ["intake.md", "profile state", "`profile_state` in `--json`"],
  // Schema exports and the baseline.
  ["intake.md", "every path ends in the baseline", "run `semlayer baseline --source <s>` next and open the conversation with it"],
  ["intake.md", "import detects the format", "`semlayer import` detects the format from the file"],
  ["intake.md", "export failures are fixed in the detail only", "is fixed in that detail only, keeping its output columns"],
  ["intake.md", "dialects without a CLI dialect", "A Redshift, MySQL or SQL Server database has no dialect of its own in the CLI"],
  ["intake.md", "older exports still import", "An older export of `information_schema.columns` still imports"],
  // Connection first (docs/PRD.md FR-1.0).
  ["intake.md", "connection first, export after", "A schema export or other shared context comes only after the owner says a connection is not possible"],
  ["intake.md", "the role only reads", "table definitions alone cannot, and the role only reads"],
  ["intake.md", "the export's reason goes in intake and the description", "the reason recorded in `intake.reason`; write the same reason into the source's `description`"],
  ["intake.md", "export-sql patterns beside --schemas", 'semlayer export-sql --dialect postgres --schemas acme --include "fct_*" --include "dim_*" --exclude "*_tmp"'],
  ["intake.md", "export-sql pushes patterns into the query", "are written into the query at its `semlayer:table-filter` line, so the export lists only those tables"],
  ["intake.md", "status names the upgrade every session", "`semlayer status` names that upgrade on every session start (`next_step.connection_upgrade` in `--json`), and `semlayer next` names it (kind `run`) as the `connect` step once every other step is done"],
  ["intake.md", "MySQL and SQL Server layers are Postgres SQL", "no tool, chat or BI tool may run it as is against that database"],
  ["intake.md", "the stand-in goes in the handoff", "list it in the handoff under Cross-source metrics and engineering asks"],
  // Read-only by construction, executable configuration, untrusted text.
  ["intake.md", "a SELECT-only role section", "### A SELECT-only role"],
  ["intake.md", "the role warning", "the CLI prints one warning when the role is a superuser or can write to a table"],
  ["intake.md", "grants for a SELECT-only role", "grant select on all tables in schema sales, marts to semlayer_reader;"],
  ["intake.md", "source checks", "**Source checks.** A source file is executable configuration"],
  ["intake.md", "views are one table expression", "Each `connection.views` relation is one table expression"],
  ["intake.md", "sources and goldens are reviewed like code", "`sources/` and `goldens/` are reviewed in pull requests like code"],
  ["intake.md", "a DDL import reads no data", "creates the columns of a `CREATE TABLE ... AS` or a view without reading any data"],
  // Time zones per type and dialect.
  ["intake.md", "naive timestamps bucket in their recorded zone", "the session zone does not move them"],
  // connection.views holds one table expression, so a rule needing an aggregate goes to engineering.
  ["intake.md", "connection.views holds no aggregate", "`connection.views` never holds a rule the model YAML cannot express"],
  ["intake.md", "an aggregate needs the owner's engineers on every dialect", "On every dialect it needs a table or view the owner's engineers create"],
  // The SELECT-only role.
  ["intake.md", "a superuser reads server files despite read-only", "a read-only transaction does not stop a superuser or a member of `pg_read_server_files`"],
  ["intake.md", "public's CREATE is revoked on old Postgres", "revoke create on schema public from public;"],
  ["intake.md", "views sample by sorting every row", "its sample sorts every row at random, which reads the whole table"],
];
