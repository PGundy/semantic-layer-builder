// Codes of the issues of a source file and its connection: credentials, DuckDB setup and views
// (lib/source-safety.ts), the scope and its table-list file, the snapshot, the intake block
// (lib/intake.ts) and env files.
import type { CodeFamily } from "./index.ts";

const codes: CodeFamily = {
  "source.setup_not_allowed": { level: "error", meaning: "A DuckDB connection.setup statement is outside the allowlist." },
  "source.view_not_one_table": { level: "error", meaning: "A DuckDB connection.views entry is not one table expression." },
  "source.credential_in_file": { level: "error", meaning: "A source file's connection holds a credential." },
  "source.env_and_prefix": { level: "error", meaning: "A source's connection has both env and env_prefix." },
  "source.key_unused": { level: "warning", meaning: "A connection key is used only by another dialect than the source's." },
  "source.pattern_invalid": { level: "error", meaning: "A scope.include or scope.exclude entry is not a usable pattern." },
  "source.tables_file_unreadable": { level: "error", meaning: "scope.tables_file names a path outside the semantic root, or one that cannot be read." },
  "source.tables_file_missing": { level: "error", meaning: "scope.tables_file names a file that does not exist." },
  "source.tables_file_entry_invalid": { level: "error", meaning: "An entry of a table-list file is not a usable pattern." },
  "source.snapshot_without_source": { level: "warning", meaning: "A snapshot has no source file of the same name." },
  "source.snapshot_dialect_differs": { level: "warning", meaning: "A snapshot's dialect differs from its source's." },
  "source.connection_missing": { level: "error", meaning: "Comes from a refusal, not from validate: --env-file or SEMLAYER_ENV_FILE names a path that is not a file, so the connection variables cannot be read." },
  "intake.reason_missing": { level: "warning", meaning: "intake.mode is export and intake.reason does not say why a connection is not possible." },
  "intake.schemas_empty": { level: "warning", meaning: "intake.schemas is an empty list, which reads every schema." },
  "intake.schema_name_invalid": { level: "error", meaning: "An entry of intake.schemas is not a schema name the dialect accepts." },
  "intake.schema_in_own_database": { level: "warning", meaning: "An entry of intake.schemas names the database the DuckDB source opens, so it matches no table." },
  "intake.schema_repeated": { level: "error", meaning: "An entry of intake.schemas repeats an earlier one." },
  "intake.schema_case_differs": { level: "warning", meaning: "Two entries of intake.schemas differ only in case." },
  "intake.export_in_connection_mode": { level: "error", meaning: "intake.export is set while intake.mode is connection." },
  "intake.export_outside_root": { level: "error", meaning: "intake.export.file is not a relative path inside the semantic root." },
  "intake.export_file_missing": { level: "warning", meaning: "intake.export.file names a file that does not exist under the semantic root." },
  "intake.export_not_a_file": { level: "warning", meaning: "intake.export.file names a directory, not a file." },
  "env.file_in_root": { level: "error", meaning: "An env file sits inside the semantic root, where no secret is kept." },
  "env.file_tracked": { level: "error", meaning: "git tracks an env file the connection lookup reads, so its secrets are in the repository." },
};
export default codes;
