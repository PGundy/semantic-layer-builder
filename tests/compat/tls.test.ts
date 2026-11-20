// A Postgres source over TLS. The live tests run when SEMLAYER_TEST_TLS_URL names a server that takes
// TCP connections over TLS only, SEMLAYER_TEST_TLS_CA the CA file its certificate is signed by (made
// for the run, for 127.0.0.1 only) and PG_URL a server with no TLS, as scripts/compat-network.sh and
// the CI `compat-network` job set them; the tests of the CA file and the messages always run.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAdapter } from "../../skills/semantic-layer/scripts/lib/adapters/index.ts";
import { connectFailure, driverConnection } from "../../skills/semantic-layer/scripts/lib/adapters/postgres.ts";
import { UserError } from "../../skills/semantic-layer/scripts/lib/errors.ts";
import type { SourceConfig } from "../../skills/semantic-layer/scripts/lib/types.ts";
import { writeYaml } from "../../skills/semantic-layer/scripts/lib/yaml.ts";
import { initProject, PG_URL, semlayer, tempDir, tempRoot } from "../helpers.ts";

const TLS_URL = process.env.SEMLAYER_TEST_TLS_URL;
const CA = process.env.SEMLAYER_TEST_TLS_CA;
const live = Boolean(TLS_URL && CA && PG_URL);
let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const urlSource: SourceConfig = { source: "pg", dialect: "postgres", connection: { env: "SEMLAYER_TEST_TLS" } };
const prefixSource: SourceConfig = { source: "pg", dialect: "postgres", connection: { env_prefix: "TLS_" } };

// A URL to the TLS server with these query parameters, and with `host` in place of 127.0.0.1.
function tlsUrl(params: Record<string, string>, host = "127.0.0.1"): string {
  const u = new URL(TLS_URL!);
  u.hostname = host;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// The TLS server's connection as <PREFIX> parts.
function tlsParts(extra: Record<string, string>, host = "127.0.0.1"): Record<string, string> {
  const u = new URL(TLS_URL!);
  return {
    TLS_HOST: host,
    TLS_PORT: u.port,
    TLS_USER: decodeURIComponent(u.username),
    TLS_PASSWORD: decodeURIComponent(u.password),
    TLS_DATABASE: u.pathname.slice(1),
    ...extra,
  };
}

// Opens the source, reads whether the connection is encrypted, and closes it; or the error it threw.
async function encrypted(source: SourceConfig, env: Record<string, string>): Promise<boolean | Error> {
  let a;
  try {
    a = await openAdapter(tempRoot().root, source, env, { warn: () => {} });
  } catch (e) {
    return e as Error;
  }
  try {
    return (await a.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()")).rows[0]?.ssl === true;
  } finally {
    await a.close();
  }
}

function expectNoSecret(text: string, url: string): void {
  const u = new URL(url);
  expect(text).not.toContain(url);
  expect(text).not.toContain(decodeURIComponent(u.password));
}

describe("over TLS", () => {
  test.skipIf(!live)("sslmode=require connects encrypted, in the URL and as <PREFIX>SSLMODE", async () => {
    expect(await encrypted(urlSource, { SEMLAYER_TEST_TLS: tlsUrl({ sslmode: "require" }) })).toBe(true);
    expect(await encrypted(prefixSource, tlsParts({ TLS_SSLMODE: "require" }))).toBe(true);
  });

  test.skipIf(!live)("a server that takes only encrypted connections, reached without TLS, names how to turn it on", async () => {
    const r = await encrypted(urlSource, { SEMLAYER_TEST_TLS: TLS_URL! });
    expect(r).toBeInstanceOf(UserError);
    expect((r as Error).message).toContain("accepts only encrypted connections. Ask the owner to add sslmode=require to the URL in SEMLAYER_TEST_TLS");
    expectNoSecret((r as Error).message, TLS_URL!);
  });

  test.skipIf(!live)("a server with no TLS, asked for sslmode=require, gives the message that takes sslmode out", async () => {
    const u = new URL(PG_URL!);
    u.searchParams.set("sslmode", "require");
    const r = await encrypted(urlSource, { SEMLAYER_TEST_TLS: u.toString() });
    expect(r).toBeInstanceOf(UserError);
    expect((r as Error).message).toContain("does not take encrypted connections. Ask the owner to take sslmode out of the URL in SEMLAYER_TEST_TLS");
    expectNoSecret((r as Error).message, u.toString());
    const parts = await encrypted(prefixSource, {
      TLS_HOST: u.hostname,
      TLS_PORT: u.port,
      TLS_USER: decodeURIComponent(u.username),
      TLS_PASSWORD: decodeURIComponent(u.password),
      TLS_DATABASE: u.pathname.slice(1) || "postgres",
      TLS_SSLMODE: "require",
    });
    expect((parts as Error).message).toContain("Ask the owner to set TLS_SSLMODE=disable, or take that line out");
  });

  test.skipIf(!live)("verify-full with the container's CA file connects, by sslrootcert in the URL and by <PREFIX>SSLROOTCERT", async () => {
    expect(await encrypted(urlSource, { SEMLAYER_TEST_TLS: tlsUrl({ sslmode: "verify-full", sslrootcert: CA! }) })).toBe(true);
    expect(await encrypted(prefixSource, tlsParts({ TLS_SSLMODE: "verify-full", TLS_SSLROOTCERT: CA! }))).toBe(true);
  });

  test.skipIf(!live)("verify-full without the CA file names how to give it", async () => {
    for (const [source, env, hint] of [
      [urlSource, { SEMLAYER_TEST_TLS: tlsUrl({ sslmode: "verify-full" }) }, "add sslrootcert=<path of the CA file> to the URL in SEMLAYER_TEST_TLS"],
      [prefixSource, tlsParts({ TLS_SSLMODE: "verify-full" }), "add the line TLS_SSLROOTCERT=<path of the CA file> beside TLS_HOST"],
    ] as const) {
      const r = await encrypted(source, env);
      expect(r).toBeInstanceOf(UserError);
      expect((r as Error).message).toContain("presents a certificate this machine cannot verify");
      expect((r as Error).message).toContain(hint);
    }
  });

  test.skipIf(!live)("verify-full checks the host name against the certificate; verify-ca checks only its signature", async () => {
    // The certificate is for 127.0.0.1 only, so localhost reaches the same server under another name.
    const full = await encrypted(prefixSource, tlsParts({ TLS_SSLMODE: "verify-full", TLS_SSLROOTCERT: CA! }, "localhost"));
    expect(full).toBeInstanceOf(UserError);
    expect((full as Error).message).toContain("presents a certificate this machine cannot verify");
    expect((full as Error).message).toContain("connect by that name");
    expect(await encrypted(prefixSource, tlsParts({ TLS_SSLMODE: "verify-ca", TLS_SSLROOTCERT: CA! }, "localhost"))).toBe(true);
    expect(await encrypted(urlSource, { SEMLAYER_TEST_TLS: tlsUrl({ sslmode: "verify-full", sslrootcert: CA! }, "localhost") })).toBeInstanceOf(UserError);
    expect(await encrypted(urlSource, { SEMLAYER_TEST_TLS: tlsUrl({ sslmode: "verify-ca", sslrootcert: CA! }, "localhost") })).toBe(true);
  });

  test.skipIf(!live)("setup over verify-full with the CA file reads the snapshot, and the CA path is not written to the source file", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    const env = tlsParts({ TLS_SSLMODE: "verify-full", TLS_SSLROOTCERT: CA! });
    const r = await semlayer(t.root, ["setup", "--source", "pg", "--dialect", "postgres", "--env-prefix", "TLS_", "--schemas", "public", "--json"], env);
    expect(r.code).toBe(0);
    expect(r.json<{ snapshot: { read: boolean } }>().snapshot.read).toBe(true);
    expect(`${r.out}${r.err}`).not.toContain(env.TLS_PASSWORD);
    expect(Bun.file(join(t.root, "sources", "pg.yaml")).text()).resolves.not.toContain(CA!);
  });
});

describe("the CA certificate file", () => {
  const USER = "tls_reader";
  const PASSWORD = "tl5-s3cret";
  const url = (params: string) => `postgres://${USER}:${encodeURIComponent(PASSWORD)}@db.internal:5432/acme?${params}`;
  const parts = (extra: Record<string, string>) => ({ TLS_HOST: "db.internal", TLS_USER: USER, TLS_PASSWORD: PASSWORD, TLS_DATABASE: "acme", ...extra });
  const refusal = (f: () => unknown): UserError => {
    try {
      f();
    } catch (e) {
      return e as UserError;
    }
    throw new Error("not refused");
  };

  test("a file that cannot be read, or holds no certificate, is refused with its code before connecting, naming no value", () => {
    const dir = tempDir("tls-ca");
    const notPem = join(dir, "ca.txt");
    writeFileSync(notPem, "not a certificate\n");
    const missing = join(dir, "no-such-ca.crt");
    for (const [path, why] of [
      [missing, "cannot be read"],
      [dir, "cannot be read"],
      [notPem, "holds no certificate (it is not a PEM file)"],
    ] as const) {
      const byUrl = refusal(() => driverConnection(urlSource, { SEMLAYER_TEST_TLS: url(`sslmode=verify-full&sslrootcert=${encodeURIComponent(path)}`) }, 1000));
      expect(byUrl.code).toBe("source.ssl_root_cert_unreadable");
      expect(byUrl.message).toBe(
        `Source "pg": sslrootcert in the URL in SEMLAYER_TEST_TLS names a file that ${why}. ` +
          "Ask the owner for the CA certificate file the server's certificate is signed by, and to set that file's path there, then run the same command again.",
      );
      const byPart = refusal(() => driverConnection(prefixSource, parts({ TLS_SSLMODE: "verify-full", TLS_SSLROOTCERT: path }), 1000));
      expect(byPart.code).toBe("source.ssl_root_cert_unreadable");
      expect(byPart.message).toContain(`TLS_SSLROOTCERT names a file that ${why}.`);
      for (const m of [byUrl.message, byPart.message]) {
        expect(m).not.toContain(path);
        expect(m).not.toContain(PASSWORD);
        expect(m).not.toContain(USER);
      }
    }
  });

  test("<PREFIX>SSLROOTCERT asks for an SSLMODE that uses it", () => {
    const pem = join(tempDir("tls-ca"), "ca.crt");
    writeFileSync(pem, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    for (const mode of [undefined, "disable", "allow", "prefer"]) {
      const r = refusal(() => driverConnection(prefixSource, parts({ TLS_SSLROOTCERT: pem, ...(mode ? { TLS_SSLMODE: mode } : {}) }), 1000));
      expect(r.message).toBe(
        'Source "pg": TLS_SSLROOTCERT is set, so TLS_SSLMODE must be verify-full (or verify-ca, or require) beside it; ask the owner to correct it, then run the same command again.',
      );
    }
    const tls = (mode: string) => driverConnection(prefixSource, parts({ TLS_SSLROOTCERT: pem, TLS_SSLMODE: mode }), 1000).options.tls as Record<string, unknown>;
    expect(tls("verify-full").ca).toBeDefined();
    expect(tls("verify-full").checkServerIdentity).toBeUndefined();
    for (const mode of ["verify-ca", "require"]) expect(typeof tls(mode).checkServerIdentity).toBe("function");
  });

  test("a certificate that cannot be verified is named without the driver's credentials", () => {
    for (const conn of [driverConnection(urlSource, { SEMLAYER_TEST_TLS: url("sslmode=verify-full") }, 1000), driverConnection(prefixSource, parts({ TLS_SSLMODE: "verify-full" }), 1000)]) {
      const e = Object.assign(new Error(`unable to verify the first certificate for ${USER}:${PASSWORD}@db.internal`), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      const m = connectFailure("pg", e, conn, "the environment").message;
      expect(m).toContain('Source "pg": the database at db.internal port 5432 (the environment) presents a certificate this machine cannot verify');
      expect(m).toContain("then run the same command again.");
      expect(m).not.toContain(PASSWORD);
      expect(m).not.toMatch(new RegExp(`\\b${USER}\\b`));
    }
  });

  test("semlayer --json carries the refusal's code", async () => {
    const t = tempRoot();
    cleanup = t.cleanup;
    await initProject(t.root);
    writeYaml(join(t.root, "sources", "pg.yaml"), prefixSource);
    const r = await semlayer(t.root, ["introspect", "--source", "pg", "--json"], parts({ TLS_SSLMODE: "verify-full", TLS_SSLROOTCERT: join(t.dir, "missing.crt") }));
    expect(r.code).toBe(1);
    expect(r.json<{ code: string; error: string }>()).toMatchObject({ code: "source.ssl_root_cert_unreadable" });
    expect(r.out).not.toContain(PASSWORD);
  });
});
