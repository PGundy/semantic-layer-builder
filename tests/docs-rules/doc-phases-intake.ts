import type { DocRule } from "./index.ts";

// The procedure rules references/phases/intake.md keeps: one phrase per rule.
export const RULES: DocRule[] = [
  ["phases/intake.md", "lake discovery with the agent's own tools", "list its files with your own file tools or ask the owner for the listing"],
  // Schema exports and the baseline.
  ["phases/intake.md", "the export path in intake", "`semlayer export-sql --dialect <d> [--schemas a,b] [--include <p>]... [--exclude <p>]...` prints the read-only catalog query for their database"],
  ["phases/intake.md", "the export reads no table data", "it reads only the catalog, never table data"],
  ["phases/intake.md", "import detects the format", "The format is detected from the file"],
  ["phases/intake.md", "the baseline is worded as guesses", "every heuristic worded as a guess with its reason, never as fact"],
  ["phases/intake.md", "the baseline drives the session", "its candidate splits become dimensions"],
  ["phases/intake.md", "nothing in the baseline stands unconfirmed", "Nothing in it stands until the owner confirms it in a readback"],
  ["phases/intake.md", "baseline without profiles", "Without profiles it says which facts `semlayer profile` would measure"],
  ["phases/intake.md", "scope before following the baseline's profile hint", "scope first (`phases/scope.md`) and ignore its closing `semlayer profile` and `semlayer draft` hint until the scope is written"],
  ["phases/intake.md", "baseline only for sources with a snapshot", "`semlayer baseline` for each source that now has a snapshot"],
  ["phases/intake.md", "import names the saved file", "`semlayer setup --source <s> --dialect <d> --export <the saved file> --reason \"<why>\"` (`schema.csv`, or `schema.tsv` from MySQL) imports it"],
  // Connection first (docs/PRD.md FR-1.0).
  ["phases/intake.md", "the first message asks for a connection", "your first message asks for a read-only connection to each source, with one plain sentence of why (Connection first, below), before anything about an export"],
  ["phases/intake.md", "a connection first, with its reason", "Ask for a read-only connection to each source before anything else, with one plain sentence of why: profiles, join evidence and goldens need the data"],
  ["phases/intake.md", "the role only reads", "and the role only reads"],
  ["phases/intake.md", "the export only after the owner says no, with the reason recorded", "Offer the schema export only after the owner says so, and record why in their words: `semlayer setup --source <s> --dialect <d> --export <file> --reason \"<why>\"` writes it to `intake.reason`, and you add it to the source's `description`"],
  ["phases/intake.md", "the role SQL is for the owner's administrator", "`semlayer setup --print-role-sql --dialect <d> --schemas a,b` prints the statements for a least-privilege, read-only role on those schemas. Hand them to the owner for their database administrator to run; never run them for them"],
  ["phases/intake.md", "the role report's warning goes to the owner", "pass any warning it prints (a superuser, write privileges, schemas beyond `intake.schemas`) to the owner in plain words"],
  ["phases/intake.md", "an export source approves definitions", "An export source may approve definitions with the owner, but profiles, join evidence, goldens and drift from data wait on a connection"],
  ["phases/intake.md", "no golden is confirmed on an export source", "no golden can be confirmed (`semlayer goldens run` and `confirm` refuse)"],
  ["phases/intake.md", "approved joins warn on an export source", "an approved join warns until its evidence exists"],
  ["phases/intake.md", "an export source is never done", "`semlayer status` never reports `done` (its last phase is `connect`)"],
  ["phases/intake.md", "the upgrade is offered at each session start", "`semlayer status` names the upgrade on every session start (`next_step.connection_upgrade`), and `semlayer next` names it (kind `run`) as the `connect` step once every other step is done; at each session start ask the owner once whether a connection is possible now"],
  ["phases/intake.md", "the upgrade's contradictions go back to the owner", "it profiles, checks every join and lists the items the data contradicts, and its next step reads them back (`semlayer readback --targets <refs>`) for the owner to answer"],
  ["phases/intake.md", "export-sql patterns beside --schemas", "`--include` and `--exclude` take the scope patterns of `phases/scope.md` and are written into the query"],
  ["phases/intake.md", "MySQL and SQL Server stop at the baseline", "for MySQL and SQL Server only the export and the baseline are supported"],
];
