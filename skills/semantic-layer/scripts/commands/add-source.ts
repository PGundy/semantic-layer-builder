import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CommandSpec } from "../lib/command.ts";
import { list, str } from "../lib/command.ts";
import { credentialHint, hasCredential } from "../lib/credentials.ts";
import { UserError } from "../lib/errors.ts";
import { SCHEMA_NAME_HINT, schemaListIssues } from "../lib/intake.ts";
import { formatJson } from "../lib/output.ts";
import { loadProject, paths } from "../lib/project.ts";
import { DIALECTS, NAME_PATTERN, RUNNABLE_DIALECTS, type Dialect, type SourceConfig, type SourceConnection } from "../lib/types.ts";
import { writeYaml } from "../lib/yaml.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VIEW_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A database value with a scheme (md:, s3://) names no local file.
const NOT_A_FILE = /^[A-Za-z][A-Za-z0-9+.-]+:/;

// Repeated string flags, kept whole: a relation or statement may contain commas.
function many(values: Record<string, unknown>, key: string): string[] {
  const v = values[key];
  if (Array.isArray(v)) return v.map(String);
  return typeof v === "string" ? [v] : [];
}

// Values are never echoed: they may hold the secret.
function refuseCredentials(flag: "--database" | "--setup" | "--view", value: string): void {
  const slot = flag === "--database" ? "database" : flag === "--setup" ? "setup" : "view";
  if (hasCredential(slot, value)) {
    throw new UserError(`${flag} contains a credential. Credentials never go in source files; ${credentialHint(slot)}`);
  }
}

const spec: CommandSpec = {
  summary: "Write sources/<name>.yaml for a new data source.",
  usage:
    "add-source --name <source> --dialect duckdb|postgres|snowflake|bigquery|databricks [--env VAR] [--database <path>] " +
    "[--view name=relation]... [--setup <statement>]... [--schemas a,b] [--description <text>]",
  options: {
    name: { type: "string" },
    dialect: { type: "string" },
    env: { type: "string" },
    database: { type: "string" },
    view: { type: "string", multiple: true },
    setup: { type: "string", multiple: true },
    schemas: { type: "string", multiple: true },
    description: { type: "string" },
  },
  async run({ values }, ctx) {
    loadProject(ctx.root);
    const name = str(values, "name");
    if (!name || !NAME_PATTERN.test(name)) throw new UserError("--name is required and must match ^[a-z][a-z0-9_]*$.");
    const dialectRaw = str(values, "dialect");
    if (!dialectRaw || !(DIALECTS as readonly string[]).includes(dialectRaw)) {
      throw new UserError(`--dialect is required and must be one of: ${DIALECTS.join(", ")}.`);
    }
    const dialect = dialectRaw as Dialect;
    const file = paths(ctx.root).source(name);
    const existing = [file, file.replace(/\.yaml$/, ".yml")].find((f) => existsSync(f));
    if (existing) throw new UserError(`Source "${name}" already exists (${existing}). Edit that file instead.`);

    const env = str(values, "env");
    const database = str(values, "database");
    const views = many(values, "view");
    const setup = many(values, "setup");
    // --schemas a,b (or repeated): the only schemas the source reads, written as intake.schemas.
    const schemas = list(values, "schemas");
    if (values.schemas !== undefined && !schemas.length) throw new UserError(`--schemas needs at least one schema name; ${SCHEMA_NAME_HINT}.`);
    const schemaIssues = schemaListIssues(schemas, { dialect, connection: { database } }, (i) => `name ${i + 1}`);
    const schemaError = schemaIssues.find((x) => x.level === "error");
    if (schemaError) throw new UserError(`--schemas: ${schemaError.path} ${schemaError.message}. Fix it and run sl add-source again.`);

    if (env !== undefined) {
      // The value is never echoed: it may be the secret itself.
      if (env.includes("://") || env.includes("@") || !ENV_NAME.test(env)) {
        throw new UserError(
          "--env takes the NAME of an environment variable, not a connection URL. Put the URL in an environment variable " +
            "(for example export WAREHOUSE_URL=...) and pass --env WAREHOUSE_URL.",
        );
      }
      if (dialect === "duckdb") throw new UserError("duckdb sources do not use --env; pass --database <path> and --view name=relation instead.");
    }
    if (dialect === "postgres" && !env) {
      throw new UserError("postgres sources need --env <VAR>: the name of the environment variable holding the connection URL.");
    }
    if (dialect !== "duckdb" && (database !== undefined || views.length || setup.length)) {
      throw new UserError("--database, --view and --setup apply only to duckdb sources.");
    }

    const connection: SourceConnection = {};
    if (env) connection.env = env;
    if (dialect === "duckdb") {
      const db = database ?? ":memory:";
      if (!db.trim()) throw new UserError("--database must not be empty.");
      refuseCredentials("--database", db);
      connection.database = db;
      if (setup.length) {
        for (const stmt of setup) refuseCredentials("--setup", stmt);
        connection.setup = setup;
      }
      if (views.length) {
        const out: Record<string, string> = {};
        for (const v of views) {
          const eq = v.indexOf("=");
          const viewName = eq < 0 ? "" : v.slice(0, eq).trim();
          const relation = eq < 0 ? "" : v.slice(eq + 1).trim();
          if (!viewName || !relation) throw new UserError(`--view must be name=relation, for example events=read_parquet('data/events/*.parquet'); got "${v}".`);
          if (!VIEW_NAME.test(viewName)) throw new UserError(`View name "${viewName}" must be letters, digits and underscores, starting with a letter or underscore.`);
          if (viewName in out) throw new UserError(`View "${viewName}" is given twice.`);
          refuseCredentials("--view", relation);
          out[viewName] = relation;
        }
        connection.views = out;
      }
    }

    const source: SourceConfig = { source: name, dialect };
    const description = str(values, "description");
    if (description) source.description = description;
    if (Object.keys(connection).length) source.connection = connection;
    if (schemas.length) source.intake = { mode: "connection", schemas };
    writeYaml(file, source);

    const runnable = RUNNABLE_DIALECTS.includes(dialect);
    const notes: string[] = schemaIssues.map((x) => `--schemas: ${x.path} ${x.message}.`);
    if (env && !ctx.env[env]) notes.push(`Environment variable ${env} is not set in this shell; set it before running queries.`);
    const db = connection.database;
    if (dialect === "duckdb" && db !== undefined && db !== ":memory:" && !NOT_A_FILE.test(db) && !existsSync(resolve(ctx.root, db))) {
      notes.push("The database file does not exist yet; its path resolves from the semantic root.");
    }
    // A name may hold $, which a shell would expand, so such a list is single-quoted.
    const schemaList = schemas.join(",");
    const schemaArg = schemaList.includes("$") ? `'${schemaList}'` : schemaList;
    const schemaFlag = schemas.length ? ` --schemas ${schemaArg}` : dialect === "bigquery" ? " --schemas <dataset>" : "";
    const next = runnable
      ? `sl introspect --source ${name}${schemaFlag}`
      : `sl introspect --source ${name}${schemaFlag} --emit-sql, run the queries with your own tool, then rerun with --results <file>`;
    // Setup statements and the database value stay out of the output.
    const viewNames = Object.keys(connection.views ?? {});
    const setupCount = connection.setup?.length ?? 0;

    if (ctx.json) {
      ctx.out(formatJson({ source: name, dialect, path: file, env: env ?? null, views: viewNames, setup_statements: setupCount, schemas, runnable, notes, next }));
    } else {
      const parts = [
        dialect,
        ...(viewNames.length ? [`views ${viewNames.join(", ")}`] : []),
        ...(setupCount ? [`${setupCount} setup statement${setupCount === 1 ? "" : "s"}`] : []),
        ...(schemas.length ? [`schema${schemas.length === 1 ? "" : "s"} ${schemas.join(", ")}`] : []),
      ];
      ctx.out(`Wrote ${relative(ctx.cwd, file) || file} (${parts.join("; ")}).`);
      for (const n of notes) ctx.out(n);
      ctx.out(`Next: ${next}`);
    }
    return 0;
  },
};

export default spec;
