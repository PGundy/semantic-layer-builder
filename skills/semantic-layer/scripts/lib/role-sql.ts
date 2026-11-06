// The statements a database administrator runs to create a least-privilege, read-only role for
// the CLI, limited to the schemas a source reads (spec: Setup, Printing a read-only role). The
// CLI prints them and never connects or runs them.
import { list, str, type CommandContext, type OptionValues } from "./command.ts";
import { UserError } from "./errors.ts";
import { formatJson } from "./output.ts";

export const ROLE_SQL_DIALECTS = ["postgres", "redshift", "snowflake", "bigquery", "databricks"] as const;
export type RoleSqlDialect = (typeof ROLE_SQL_DIALECTS)[number];
export const DEFAULT_ROLE_NAME = "sl_reader";

// A plain identifier: letters, digits and underscores, not starting with a digit. Anything else is
// refused, so no name can close a quote or start another statement.
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A Google Cloud project id.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// A service account id, which the role name becomes on BigQuery with _ written as -.
const ACCOUNT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface RoleSqlInput {
  dialect: RoleSqlDialect;
  schemas: string[];
  role: string;
  database?: string;
  warehouse?: string;
  catalog?: string;
  project?: string;
}

export interface RoleSql {
  dialect: RoleSqlDialect;
  role: string;
  schemas: string[];
  // sql: statements for the database's SQL console; shell: commands for a terminal (BigQuery).
  language: "sql" | "shell";
  // Each runnable statement or command; the text adds comment lines around them.
  statements: string[];
  text: string;
  placeholders: string[];
}

const q2 = (name: string) => `"${name}"`;
const bt = (name: string) => `\`${name}\``;

// A refused name is not echoed, in case it holds something that should not be printed; the flag
// (and for --schemas its place in the list) names it.
function plain(flag: string, value: string): string {
  if (!PLAIN.test(value)) {
    throw new UserError(
      `${flag} is not a plain identifier (letters, digits and underscores, not starting with a digit), so sl setup does not ` +
        "print statements for it. Rename it in the command, or write the grants for that name by hand.",
    );
  }
  return value;
}

function need(flag: string, value: string | undefined, dialect: string, what: string): string {
  if (value === undefined || !value.trim()) throw new UserError(`--print-role-sql --dialect ${dialect} needs ${flag} <name>, ${what}; run it again with ${flag}.`);
  return value.trim();
}

const header = (input: RoleSqlInput, c: string, what: string) => [
  `${c} A read-only ${what} for the semantic layer CLI, limited to ${input.dialect === "bigquery" ? "dataset" : "schema"}${input.schemas.length === 1 ? "" : "s"} ${input.schemas.join(", ")}.`,
  `${c} Run by an administrator. sl setup printed this and ran nothing.`,
];

function postgres(input: RoleSqlInput): Omit<RoleSql, "text"> & { lines: string[] } {
  const r = q2(input.role);
  const redshift = input.dialect === "redshift";
  const statements: string[] = [];
  // Redshift's CREATE ROLE has no LOGIN: a user logs in, so the reader is a user there.
  statements.push(redshift ? `CREATE USER ${r} PASSWORD '<password>';` : `CREATE ROLE ${r} LOGIN PASSWORD '<password>';`);
  if (input.database) statements.push(`GRANT CONNECT ON DATABASE ${q2(input.database)} TO ${r};`);
  for (const s of input.schemas) {
    statements.push(
      `GRANT USAGE ON SCHEMA ${q2(s)} TO ${r};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${q2(s)} TO ${r};`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${q2(s)} GRANT SELECT ON TABLES TO ${r};`,
    );
  }
  if (!redshift) statements.push(`ALTER ROLE ${r} SET default_transaction_read_only = on;`);
  const lines = [
    ...header(input, "--", redshift ? "user" : "role"),
    "-- Replace <password> with a new password; it goes in the connection URL's environment variable, never in a file.",
    ...statements,
    "-- ALTER DEFAULT PRIVILEGES covers tables the administrator running it creates later; for tables another role",
    "-- creates, run it again with FOR ROLE <that role> after ALTER DEFAULT PRIVILEGES.",
  ];
  if (!redshift) lines.push("-- On Postgres 14 or earlier every role may create objects in schema public; close that with:", "-- REVOKE CREATE ON SCHEMA public FROM PUBLIC;");
  return { dialect: input.dialect, role: input.role, schemas: input.schemas, language: "sql", statements, lines, placeholders: ["<password>"] };
}

function snowflake(input: RoleSqlInput): Omit<RoleSql, "text"> & { lines: string[] } {
  const r = q2(input.role);
  const db = q2(input.database!);
  const statements = [`CREATE ROLE IF NOT EXISTS ${r};`, `GRANT USAGE ON WAREHOUSE ${q2(input.warehouse!)} TO ROLE ${r};`, `GRANT USAGE ON DATABASE ${db} TO ROLE ${r};`];
  for (const s of input.schemas) {
    const schema = `${db}.${q2(s)}`;
    statements.push(
      `GRANT USAGE ON SCHEMA ${schema} TO ROLE ${r};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ROLE ${r};`,
      `GRANT SELECT ON ALL VIEWS IN SCHEMA ${schema} TO ROLE ${r};`,
      `GRANT SELECT ON FUTURE TABLES IN SCHEMA ${schema} TO ROLE ${r};`,
      `GRANT SELECT ON FUTURE VIEWS IN SCHEMA ${schema} TO ROLE ${r};`,
    );
  }
  statements.push(`GRANT ROLE ${r} TO USER <user>;`);
  const lines = [
    ...header(input, "--", "role"),
    "-- Names are quoted, so they match only the exact case given: write them as SHOW SCHEMAS shows them (usually upper case).",
    "-- The role is created in the case given too; unless it is upper case, USE ROLE and the connector name it quoted.",
    "-- Replace <user> with the user the connector logs in as. Run as SECURITYADMIN or a role that owns these objects.",
    ...statements,
  ];
  return { dialect: "snowflake", role: input.role, schemas: input.schemas, language: "sql", statements, lines, placeholders: ["<user>"] };
}

function bigquery(input: RoleSqlInput): Omit<RoleSql, "text"> & { lines: string[] } {
  const project = input.project!;
  const account = input.role.replace(/_/g, "-");
  const member = `serviceAccount:${account}@${project}.iam.gserviceaccount.com`;
  const statements = [
    `gcloud iam service-accounts create ${account} --project=${project} --display-name="Semantic layer reader"`,
    `gcloud projects add-iam-policy-binding ${project} --member=${member} --role=roles/bigquery.jobUser`,
    ...input.schemas.map((s) => `bq query --project_id=${project} --nouse_legacy_sql 'GRANT ${bt("roles/bigquery.dataViewer")} ON SCHEMA ${bt(project)}.${bt(s)} TO "${member}"'`),
  ];
  const lines = [
    ...header(input, "#", "service account"),
    "# roles/bigquery.jobUser on the project lets it run queries; roles/bigquery.dataViewer on each dataset lets it read only those.",
    "# Run in a shell signed in to gcloud as a project administrator. The connector then uses this service account,",
    "# through workload identity or a key kept outside the semantic root.",
    "# For datasets outside the US multi-region, add --location=<region> to each bq query.",
    ...statements,
  ];
  return { dialect: "bigquery", role: account, schemas: input.schemas, language: "shell", statements, lines, placeholders: [] };
}

function databricks(input: RoleSqlInput): Omit<RoleSql, "text"> & { lines: string[] } {
  const r = bt(input.role);
  const catalog = bt(input.catalog!);
  const statements = [`GRANT USE CATALOG ON CATALOG ${catalog} TO ${r};`];
  for (const s of input.schemas) statements.push(`GRANT USE SCHEMA ON SCHEMA ${catalog}.${bt(s)} TO ${r};`, `GRANT SELECT ON SCHEMA ${catalog}.${bt(s)} TO ${r};`);
  const lines = [
    ...header(input, "--", "group"),
    `-- ${input.role} is a group (or service principal) created in the account console; add the connector's service principal to it.`,
    "-- SELECT on a schema covers its tables and views, including ones created later. Run as the catalog owner or a metastore admin.",
    ...statements,
  ];
  return { dialect: "databricks", role: input.role, schemas: input.schemas, language: "sql", statements, lines, placeholders: [] };
}

// The statements for one dialect. Every name is checked first; a name that is not a plain
// identifier is refused, naming the flag.
export function roleSql(raw: RoleSqlInput): RoleSql {
  const input: RoleSqlInput = { ...raw, schemas: [...new Set(raw.schemas.map((s, i) => plain(`--schemas name ${i + 1}`, s)))], role: plain("--role-name", raw.role) };
  if (input.database !== undefined) plain("--database", input.database);
  if (input.warehouse !== undefined) plain("--warehouse", input.warehouse);
  if (input.catalog !== undefined) plain("--catalog", input.catalog);
  let built: Omit<RoleSql, "text"> & { lines: string[] };
  switch (input.dialect) {
    case "postgres":
    case "redshift":
      built = postgres(input);
      break;
    case "snowflake":
      built = snowflake(input);
      break;
    case "bigquery": {
      if (!PROJECT_ID.test(input.project!)) {
        throw new UserError(`--project is not a Google Cloud project id (6 to 30 lower-case letters, digits and hyphens, starting with a letter).`);
      }
      const account = input.role.replace(/_/g, "-");
      if (!ACCOUNT_ID.test(account)) {
        throw new UserError(
          `--role-name: on BigQuery the role is a service account named ${account}, which needs 6 to 30 lower-case letters, digits and hyphens, starting with a letter; pick another --role-name.`,
        );
      }
      built = bigquery(input);
      break;
    }
    case "databricks":
      built = databricks(input);
      break;
  }
  const { lines, ...rest } = built;
  return { ...rest, text: `${lines.join("\n")}\n` };
}

// The flags --print-role-sql takes; any other setup flag is refused with it.
export const ROLE_SQL_FLAGS = new Set(["print-role-sql", "dialect", "schemas", "role-name", "database", "warehouse", "catalog", "project"]);

// sl setup --print-role-sql: checks the flags, prints the statements and the next step, and writes
// nothing. It needs no project and never opens a connection.
export function printRoleSql(values: OptionValues, ctx: CommandContext): number {
  const other = Object.keys(values).filter((k) => values[k] !== undefined && !ROLE_SQL_FLAGS.has(k) && !["root", "json", "help"].includes(k));
  if (other.length) {
    throw new UserError(
      `--print-role-sql only prints statements, so it takes no ${other.map((k) => `--${k}`).join(", ")}. ` +
        "Run sl setup --print-role-sql --dialect <d> --schemas a,b alone, then sl setup with the connection once the role exists.",
    );
  }
  const dialect = str(values, "dialect");
  if (!dialect || !(ROLE_SQL_DIALECTS as readonly string[]).includes(dialect)) {
    const duck = dialect === "duckdb" ? " A duckdb source opens a file and needs no database role." : "";
    throw new UserError(`--print-role-sql needs --dialect, one of: ${ROLE_SQL_DIALECTS.join(", ")}.${duck}`);
  }
  const d = dialect as RoleSqlDialect;
  const schemas = list(values, "schemas");
  if (!schemas.length) throw new UserError("--print-role-sql needs --schemas a,b: the role reads only the schemas the layer covers (for BigQuery, the datasets).");
  const opt = (k: string) => {
    const v = str(values, k);
    if (v !== undefined && !v.trim()) throw new UserError(`--${k} must not be empty.`);
    return v?.trim();
  };
  // Snowflake reads an unquoted role name in upper case, so its default role is upper case.
  const role = opt("role-name") ?? (d === "snowflake" ? DEFAULT_ROLE_NAME.toUpperCase() : DEFAULT_ROLE_NAME);
  const input: RoleSqlInput = { dialect: d, schemas, role, database: opt("database") };
  const unused = (flags: string[]) => {
    const given = flags.filter((f) => opt(f) !== undefined);
    if (given.length) throw new UserError(`--dialect ${d} uses no ${given.map((f) => `--${f}`).join(" or ")}; run it again without.`);
  };
  if (d === "postgres" || d === "redshift") unused(["warehouse", "catalog", "project"]);
  if (d === "snowflake") {
    unused(["catalog", "project"]);
    input.database = need("--database", input.database, d, "the database that holds the schemas");
    input.warehouse = need("--warehouse", opt("warehouse"), d, "the warehouse the role runs queries on");
  }
  if (d === "bigquery") {
    unused(["database", "warehouse", "catalog"]);
    input.project = need("--project", opt("project"), d, "the project that holds the datasets");
  }
  if (d === "databricks") {
    unused(["database", "warehouse", "project"]);
    input.catalog = need("--catalog", opt("catalog"), d, "the catalog that holds the schemas");
  }
  const out = roleSql(input);
  const who = `Give these ${out.language === "shell" ? "commands" : "statements"} to the database administrator. Once the role exists, `;
  const list_ = out.schemas.join(",");
  const next =
    d === "postgres"
      ? `${who}the owner puts its connection URL in an environment variable and the CLI connects with sl setup --source <source> --dialect postgres --env <VAR> --schemas ${list_}.`
      : d === "redshift"
        ? `${who}your warehouse connector logs in as it and runs the read-only queries; for a schema export instead, sl export-sql --dialect redshift --schemas ${list_}.`
        : `${who}your warehouse connector logs in with it and runs the CLI's query plans: sl setup --source <source> --dialect ${d} --env <VAR> --schemas ${list_}.`;
  if (ctx.json) {
    ctx.out(formatJson({ dialect: out.dialect, role: out.role, schemas: out.schemas, language: out.language, statements: out.statements, text: out.text, placeholders: out.placeholders, next }));
  } else {
    ctx.out(out.text.trimEnd());
    ctx.out("");
    ctx.out(`Next: ${next}`);
  }
  return 0;
}

// The --schemas value for a printed role: intake.schemas when each is a plain identifier, which
// --print-role-sql accepts, else <schemas> for the owner to fill.
export function roleSqlSchemasFlag(schemas: unknown): string {
  const list = Array.isArray(schemas) ? schemas : [];
  return list.length && list.every((s) => typeof s === "string" && PLAIN.test(s)) ? list.join(",") : "<schemas>";
}

// The line introspect and setup print when the connection's role can do more than read the
// schemas the layer covers: tell the owner, and the command that prints a narrower role.
export function roleNote(source: { source: string; intake?: { schemas?: unknown } }, report: { warnings: string[]; superuser: boolean; schemas_measured?: boolean }): string {
  const what = report.superuser
    ? "is a superuser"
    : report.schemas_measured === false
      ? "may be able to do more than read the schemas the layer covers, since its grants could not be measured"
      : "can do more than read the schemas the layer covers";
  return (
    `The role that source "${source.source}" connects as ${what} (see the warning above). Tell the owner; their database administrator can create a ` +
    `read-only role from the statements sl setup --print-role-sql --dialect postgres --schemas ${roleSqlSchemasFlag(source.intake?.schemas)} prints.`
  );
}
