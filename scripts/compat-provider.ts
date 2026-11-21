// The provider check behind scripts/compat-provider.sh: runs semlayer against the PostgreSQL the owner's
// read-only connection URL names and writes one redacted fixture (docs/compat/postgres.md says how to use it).
//
// The fixture is built from an allowlist of fields (version numbers, yes/no facts, counts and a provider
// label from a fixed list), never by scrubbing the output of the commands. Before anything is written,
// a second check fails the run, writing nothing, when the fixture holds the host, user, database or
// password of the URL, an address or a URL. The URL is read from the environment only and is never
// printed or put on a command line.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runCli } from "../skills/semantic-layer/scripts/lib/cli.ts";
import { loadSnapshot } from "../skills/semantic-layer/scripts/lib/project.ts";

export const URL_VARIABLE = "SEMLAYER_PROVIDER_URL";
export const PROVIDERS = ["local", "supabase", "neon", "rds", "cloud-sql", "other"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const FIXTURES_DIR = "docs/compat/fixtures";
const REPO = resolve(import.meta.dir, "..");

export interface Fixture {
  fixture: 1;
  provider: Provider;
  server_version: string;
  server_version_num: number;
  tls: boolean | "unknown";
  tls_protocol: string | null;
  pooled: "yes" | "unknown";
  // Whether the role can only read the named schema; null when doctor did not measure it.
  read_only_role: boolean | null;
  catalog: { tables: number; views: number; columns: number; foreign_keys: number };
}

const KEYS = ["fixture", "provider", "server_version", "server_version_num", "tls", "tls_protocol", "pooled", "read_only_role", "catalog"];
const CATALOG_KEYS = ["tables", "views", "columns", "foreign_keys"];
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;

// Why a value is not a fixture of the allowlist schema; empty when it is one.
export function checkFixture(value: unknown): string[] {
  const o = value as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return ["it is not a JSON object"];
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) out.push(`the key "${k}" is not on the allowlist`);
  for (const k of KEYS) if (!(k in o)) out.push(`the key "${k}" is missing`);
  if (o.fixture !== 1) out.push("fixture must be 1");
  if (!PROVIDERS.includes(o.provider as Provider)) out.push(`provider must be one of ${PROVIDERS.join(", ")}`);
  if (typeof o.server_version !== "string" || !/^\d{2}\.\d{1,4}$/.test(o.server_version)) out.push("server_version must look like 16.3");
  if (!isCount(o.server_version_num) || (o.server_version_num as number) < 100000) out.push("server_version_num must be a whole number such as 160003");
  if (typeof o.server_version === "string" && isCount(o.server_version_num) && o.server_version !== `${Math.floor((o.server_version_num as number) / 10000)}.${(o.server_version_num as number) % 10000}`) out.push("server_version and server_version_num disagree");
  if (o.tls !== true && o.tls !== false && o.tls !== "unknown") out.push('tls must be true, false or "unknown"');
  if (o.tls_protocol !== null && !(typeof o.tls_protocol === "string" && /^(TLSv1(\.[0-3])?|SSLv3)$/.test(o.tls_protocol))) out.push("tls_protocol must be null or a TLS version such as TLSv1.3");
  if (o.pooled !== "yes" && o.pooled !== "unknown") out.push('pooled must be "yes" or "unknown"');
  if (o.read_only_role !== null && typeof o.read_only_role !== "boolean") out.push("read_only_role must be true, false or null");
  const c = o.catalog as Record<string, unknown> | null;
  if (typeof c !== "object" || c === null || Array.isArray(c)) out.push("catalog must be an object of counts");
  else {
    for (const k of Object.keys(c)) if (!CATALOG_KEYS.includes(k)) out.push(`catalog.${k} is not on the allowlist`);
    for (const k of CATALOG_KEYS) if (!isCount(c[k])) out.push(`catalog.${k} must be a whole number of at least 0`);
  }
  return out;
}

// Every string in a value, keys included.
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "object" && v !== null) return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

const IPV4 = /(^|[^0-9])\d{1,3}(\.\d{1,3}){3}([^0-9]|$)/;
const IPV6 = /[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f:]*/i;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;
const HOST_LIKE = /[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}/i;

// Whether a string looks like an address, a URL or a host name.
export function looksLikeLeak(text: string): boolean {
  return IPV4.test(text) || IPV6.test(text) || URL_LIKE.test(text) || HOST_LIKE.test(text);
}

// The parts of a connection URL that must not appear in a fixture. A part of four or more characters
// is searched as text; a shorter one only as a whole string, since it would match any word.
export function secretsOf(url: string): string[] {
  const u = new URL(url);
  const parts = [u.hostname, u.username, u.password, u.pathname.slice(1), u.host, url];
  // libpq also takes these as query parameters (a host list is comma-separated).
  for (const k of ["host", "hostaddr", "user", "password", "dbname"]) for (const v of u.searchParams.getAll(k)) parts.push(...v.split(","));
  for (const p of [...parts]) {
    try {
      parts.push(decodeURIComponent(p));
    } catch {
      // Not percent-encoded.
    }
  }
  return [...new Set(parts.filter((p) => p !== ""))];
}

// What is wrong with a fixture that would be written: empty when nothing leaks. It names the kind of
// leak, never the value.
export function leaks(fixture: unknown, secrets: string[]): string[] {
  const out: string[] = [];
  const all = strings(fixture);
  const text = JSON.stringify(fixture);
  for (const s of secrets) {
    if (s.length >= 4 ? text.includes(s) || all.some((x) => x.includes(s)) : all.includes(s)) out.push("a part of the connection URL (host, user, database or password)");
  }
  if (all.some(looksLikeLeak)) out.push("something that looks like an address, a URL or a host name");
  return [...new Set(out)];
}

// The doctor --json fields the fixture takes, found by name; anything else in it is ignored.
interface DoctorOut {
  checks?: { check?: unknown; status?: unknown }[];
  connections?: { source?: unknown; server_version?: unknown; server_version_num?: unknown; tls?: unknown; tls_protocol?: unknown; pooled?: unknown }[];
}
export interface Counts {
  tables: number;
  views: number;
  columns: number;
  foreign_keys: number;
}

// Builds the fixture from an allowlist; throws a plain message when doctor reported no connection.
export function buildFixture(provider: Provider, doctor: DoctorOut, counts: Counts): Fixture {
  const conn = doctor.connections?.[0];
  if (!conn || typeof conn.server_version !== "string" || typeof conn.server_version_num !== "number") throw new Error("the server did not answer with its version");
  const role = doctor.checks?.find((c) => typeof c.check === "string" && c.check.startsWith("role "));
  return {
    fixture: 1,
    provider,
    server_version: conn.server_version,
    server_version_num: conn.server_version_num,
    tls: conn.tls === true ? true : conn.tls === false ? false : "unknown",
    tls_protocol: typeof conn.tls_protocol === "string" ? conn.tls_protocol : null,
    pooled: conn.pooled === "yes" ? "yes" : "unknown",
    read_only_role: role ? role.status === "ok" : null,
    catalog: { tables: counts.tables, views: counts.views, columns: counts.columns, foreign_keys: counts.foreign_keys },
  };
}

export interface Deps {
  build: typeof buildFixture;
  say: (text: string) => void;
  // Where fixtures may be written and where the working folder is made; the defaults are the repository's.
  fixturesDir: string;
  makeTemp: () => string;
}

// The output path when it is a .json file under docs/compat/fixtures/ of this repository.
export function outputPath(out: string, cwd = process.cwd(), dir = join(REPO, FIXTURES_DIR)): string | undefined {
  const full = resolve(cwd, out);
  const rel = relative(dir, full);
  return rel && !rel.startsWith("..") && !rel.includes("/") && /^[a-z0-9][a-z0-9._-]*\.json$/.test(rel) ? full : undefined;
}

const USAGE = `usage: bash scripts/compat-provider.sh <provider> <schema> <${FIXTURES_DIR}/file.json>\n  <provider> is one of ${PROVIDERS.join(", ")}; the connection URL of a read-only role is in ${URL_VARIABLE}.`;

// Runs the check and returns the exit code; it writes the fixture only when the final check passes.
export async function runProvider(args: string[], env: Record<string, string | undefined>, deps: Partial<Deps> = {}): Promise<number> {
  const d: Deps = { build: buildFixture, say: (t) => console.error(t), fixturesDir: join(REPO, FIXTURES_DIR), makeTemp: () => mkdtempSync(join(tmpdir(), "semlayer-provider-")), ...deps };
  const [provider, schema, out] = args;
  if (args.length !== 3 || !PROVIDERS.includes(provider as Provider) || !schema || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    d.say(USAGE);
    return 2;
  }
  const url = env[URL_VARIABLE];
  if (!url) {
    d.say(`${URL_VARIABLE} is not set. Export the connection URL of a read-only role in it (semlayer setup --print-role-sql makes the role), then run this again.`);
    return 2;
  }
  let secrets: string[];
  try {
    secrets = secretsOf(url);
  } catch {
    d.say(`${URL_VARIABLE} is not a connection URL of the form postgres://<user>:<password>@<host>:<port>/<database>.`);
    return 2;
  }
  const target = outputPath(out!, process.cwd(), d.fixturesDir);
  if (!target) {
    d.say(`The output must be a .json file directly under ${FIXTURES_DIR}/, for example ${FIXTURES_DIR}/${provider}.json.`);
    return 2;
  }
  const dir = d.makeTemp();
  const root = join(dir, "semantic");
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await runCli([...argv, "--root", root], { cwd: dir, env: { ...process.env, ...env }, out: (t) => lines.push(t), err: () => {} });
    return { code, out: lines.join("\n") };
  };
  try {
    for (const argv of [["init", "--name", "provider_check"], ["setup", "--source", "provider", "--dialect", "postgres", "--env", URL_VARIABLE, "--schemas", schema, "--json"]]) {
      if ((await run(argv)).code !== 0) {
        d.say(
          `semlayer ${argv[0]} did not succeed, so nothing was written. Check the URL, the role and the schema name, then see why in a folder of your own: export ${URL_VARIABLE}=<your URL>; semlayer init; ` +
            `semlayer setup --source provider --dialect postgres --env ${URL_VARIABLE} --schemas ${schema}; semlayer doctor. The role needs USAGE and SELECT on the schema: semlayer setup --print-role-sql --dialect postgres --schemas ${schema}.`,
        );
        return 1;
      }
    }
    const snapshot = loadSnapshot(root, "provider");
    const tables = snapshot?.tables ?? [];
    const counts: Counts = {
      tables: tables.filter((t) => t.kind !== "view").length,
      views: tables.filter((t) => t.kind === "view").length,
      columns: tables.reduce((n, t) => n + t.columns.length, 0),
      foreign_keys: tables.reduce((n, t) => n + (t.foreign_keys?.length ?? 0), 0),
    };
    if (!tables.length) {
      d.say(`No fixture was written: the schema ${schema} has no table or view this role can see. Check the schema name, or give the role USAGE and SELECT: semlayer setup --print-role-sql --dialect postgres --schemas ${schema}.`);
      return 1;
    }
    const doctor = await run(["doctor", "--json"]);
    let fixture: Fixture;
    try {
      fixture = d.build(provider as Provider, JSON.parse(doctor.out) as DoctorOut, counts);
    } catch (e) {
      d.say(`No fixture was written: ${(e as Error).message}. Run semlayer doctor yourself to see why.`);
      return 1;
    }
    const wrong = [...checkFixture(fixture), ...leaks(fixture, secrets)];
    if (wrong.length) {
      d.say(`No fixture was written: the result failed its final check (${[...new Set(wrong)].join("; ")}). Nothing was saved; tell the maintainers, without the output.`);
      return 1;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
    d.say(`Wrote ${relative(process.cwd(), target)}. It holds version numbers, yes/no facts and counts only, so it is safe to commit and to paste into an issue.\nCheck it: bun test tests/compat-fixtures.test.ts. Then: git add ${relative(process.cwd(), target)}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every file under docs/compat/fixtures/, by file name (only .json fixtures are allowed there).
export function fixtureFiles(dir = join(REPO, FIXTURES_DIR)): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// The provider table of docs/compat/postgres.md: one row per fixture file, from the file alone.
export function providerTable(dir = join(REPO, FIXTURES_DIR)): string {
  const rows = fixtureFiles(dir).filter((f) => f.endsWith(".json")).map((f) => {
    const x = JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture;
    const tls = x.tls === true ? `yes${x.tls_protocol ? ` (${x.tls_protocol})` : ""}` : x.tls === false ? "no" : "unknown";
    const role = x.read_only_role === null ? "not measured" : x.read_only_role ? "yes" : "no";
    return `| \`${f}\` | ${x.provider} | ${x.server_version} | ${tls} | ${x.pooled === "yes" ? "yes (guess)" : "not seen"} | ${role} | ${x.catalog.tables} / ${x.catalog.views} / ${x.catalog.columns} |`;
  });
  return ["| Fixture | Provider | PostgreSQL | Encrypted | Pooler | Read-only role | Tables / views / columns |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

if (import.meta.main) {
  if (process.argv[2] === "table") console.log(providerTable());
  else process.exit(await runProvider(process.argv.slice(2), process.env));
}

