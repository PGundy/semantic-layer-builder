import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYamlText } from "../skills/semantic-layer/scripts/lib/yaml.ts";
import { tempDir } from "./helpers.ts";

// scripts/verify.sh (docs/PRD-hardening.md HR-1), run in a stand-in repository whose `bun` records
// its calls: a cluster verify.sh starts is stopped and removed when it exits, also when a step
// fails; one PG_URL names is left alone; and a run that leaves an sl-test-* or sl-pg-* entry in
// the temp directory fails and names it.

const REPO = join(import.meta.dir, "..");
const AS_ROOT = process.getuid?.() === 0;
const sh = (script: string) => Bun.spawnSync(["sh", "-c", script]).exitCode === 0;
// The cluster's socket is <temp directory>/sl-test-XXXXXX/sl-pg-verify.XXXXXX/.s.PGSQL.<port>, and a
// socket path has a length limit: 107 bytes on Linux, 103 on macOS and the BSDs.
const SOCKET_PATH_BYTES = Buffer.byteLength(tmpdir()) + "/sl-test-XXXXXX/sl-pg-verify.XXXXXX/.s.PGSQL.56000".length;
// Whether verify.sh can start a real cluster here: the Postgres binaries exist, the socket path
// fits and, as root, the `postgres` user the cluster runs as can reach the temp directory.
const CAN_START_PG =
  sh("ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1 || command -v pg_ctl >/dev/null") &&
  SOCKET_PATH_BYTES <= (process.platform === "linux" ? 107 : 103) &&
  (!AS_ROOT || sh(`runuser -u postgres -- test -x '${tmpdir()}'`));

const STUB_BUN = `#!/bin/sh
# Stands in for bun: records the call and, for "bun test", the cluster's process id; FAKE_TEST
# makes "bun test" leave a directory behind or fail.
echo "bun $* PG_URL=\${PG_URL:-}" >> "$FAKE_LOG"
[ "$1" = test ] || exit 0
pid_file="\${PG_URL##*host=}/data/postmaster.pid"
[ -f "$pid_file" ] && head -1 "$pid_file" > "$FAKE_LOG.pid"
case "\${FAKE_TEST:-}" in
  leak) mkdir "$TMPDIR/sl-test-leaked" ;;
  fail) exit 1 ;;
esac
exit 0
`;

const STUB_PG_LOCAL = `#!/usr/bin/env bash
# Stands in for scripts/pg-local.sh: records the call and prints a URL that names its directory;
# FAKE_PG_LOCAL=fail makes the start fail the way pg-local.sh does.
echo "pg-local \${1:-start} $PG_LOCAL_DIR" >> "$FAKE_LOG"
[ "\${1:-}" = "--stop" ] && exit 0
if [ "\${FAKE_PG_LOCAL:-}" = fail ]; then echo "pg-local: no pg_ctl in /nowhere (set PG_BIN)" >&2; exit 1; fi
mkdir -p "$PG_LOCAL_DIR/data"
echo "export PG_URL='postgres://postgres@localhost:1/postgres?host=$PG_LOCAL_DIR'"
`;

interface Ran {
  code: number;
  out: string;
  err: string;
  // The calls the stand-ins recorded, in order.
  log: string[];
  // The temp directory the run used, and the sl-* entries in it afterwards.
  tmp: string;
  left: string[];
  // The process id of the cluster "bun test" ran against, when it was a real one.
  pid?: number;
}

// Runs verify.sh in a stand-in repository that is also the run's temp directory, with `stale` more
// sl-test-* entries in it than the one every run starts with.
function verify(pgLocal: "stub" | "real", env: Record<string, string>, stale = 0): Ran {
  // A real cluster's socket path has to fit (SOCKET_PATH_BYTES), so its directory has no label.
  const dir = tempDir(pgLocal === "real" ? "" : "verify");
  const tmp = dir;
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  for (const d of [bin, join(dir, "scripts")]) mkdirSync(d);
  // As root a real cluster runs as `postgres`, which must be able to reach its directory.
  chmodSync(dir, 0o755);
  mkdirSync(join(tmp, "sl-test-there-before"));
  for (let i = 0; i < stale; i++) writeFileSync(join(tmp, `sl-test-stale-${"x".repeat(200)}-${i}`), "");
  cpSync(join(REPO, "scripts", "verify.sh"), join(dir, "scripts", "verify.sh"));
  if (pgLocal === "real") cpSync(join(REPO, "scripts", "pg-local.sh"), join(dir, "scripts", "pg-local.sh"));
  else writeFileSync(join(dir, "scripts", "pg-local.sh"), STUB_PG_LOCAL);
  writeFileSync(join(bin, "bun"), STUB_BUN);
  // verify.sh starts a cluster only where it finds Postgres binaries.
  if (pgLocal === "stub") writeFileSync(join(bin, "pg_ctl"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
  writeFileSync(log, "");
  const r = Bun.spawnSync(["bash", join(dir, "scripts", "verify.sh")], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, FAKE_LOG: log, PG_LOCAL_PORT: String(56000 + Math.floor(Math.random() * 1000)), ...env },
  });
  const pid = existsSync(`${log}.pid`) ? Number(readFileSync(`${log}.pid`, "utf8")) : undefined;
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    log: readFileSync(log, "utf8").split("\n").filter(Boolean),
    tmp,
    left: readdirSync(tmp).filter((n) => n.startsWith("sl-")).sort(),
    pid,
  };
}

const ELSEWHERE = "postgres://postgres@localhost:1/elsewhere";

describe("scripts/verify.sh", () => {
  test("ends with verify: ok when the run leaves nothing, and leaves a cluster PG_URL names alone", () => {
    const r = verify("stub", { PG_URL: ELSEWHERE });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("verify: ok");
    expect(r.log).toEqual([`bun install --frozen-lockfile PG_URL=${ELSEWHERE}`, `bun run typecheck PG_URL=${ELSEWHERE}`, `bun test PG_URL=${ELSEWHERE}`]);
    // What was in the temp directory before the run is not the run's.
    expect(r.left).toEqual(["sl-test-there-before"]);
  });

  test("fails and names the temp directory a test left behind", () => {
    const r = verify("stub", { PG_URL: ELSEWHERE, FAKE_TEST: "leak" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("verify: ok");
    expect(r.err).toContain("left temporary files behind");
    expect(r.err).toContain(`  ${join(r.tmp, "sl-test-leaked")}\n`);
    expect(r.err).not.toContain("sl-test-there-before");
    expect(r.err).toContain("tempDir() or tempRoot() from tests/helpers.ts");
    expect(r.err).toContain("run again: bash scripts/verify.sh");
  });

  // As one command-line argument a list this long is refused by the system ("Argument list too
  // long"), so a comparison that passes it that way finds nothing.
  test("names the directory a test left behind when the temp directory already held a long list of entries", () => {
    const r = verify("stub", { PG_URL: ELSEWHERE, FAKE_TEST: "leak" }, 700);
    expect(r.left).toHaveLength(702);
    expect(r.left.join("\n").length).toBeGreaterThan(140_000);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("verify: ok");
    expect(r.err).toContain(`  ${join(r.tmp, "sl-test-leaked")}\n`);
    expect(r.err).not.toContain("sl-test-stale-");
    expect(r.err).not.toContain("too long");
    const clean = verify("stub", { PG_URL: ELSEWHERE }, 700);
    expect(clean.err).toBe("");
    expect(clean.code).toBe(0);
    expect(clean.out.trim().split("\n").at(-1)).toBe("verify: ok");
  });

  test("with PG_URL unset it starts a cluster of its own for the tests, then stops and removes it", () => {
    const r = verify("stub", {});
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("verify: ok");
    const dir = /^pg-local start (.+)$/.exec(r.log[2] ?? "")?.[1] ?? "";
    expect(dir).toStartWith(join(r.tmp, "sl-pg-verify."));
    expect(r.log.slice(2)).toEqual([`pg-local start ${dir}`, `bun test PG_URL=postgres://postgres@localhost:1/postgres?host=${dir}`, `pg-local --stop ${dir}`]);
    expect(r.left).toEqual(["sl-test-there-before"]);
  });

  test("stops and removes its own cluster when a step fails", () => {
    const r = verify("stub", { FAKE_TEST: "fail" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("verify: ok");
    expect(r.log.at(-1)).toStartWith(`pg-local --stop ${join(r.tmp, "sl-pg-verify.")}`);
    expect(r.left).toEqual(["sl-test-there-before"]);
  });

  test("stops with pg-local.sh's own message when the cluster does not start", () => {
    const r = verify("stub", { FAKE_PG_LOCAL: "fail" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("verify: ok");
    expect(r.err).toContain("pg-local: no pg_ctl in /nowhere (set PG_BIN)");
    expect(r.err).not.toContain("Postgres tests will skip");
    expect(r.log.some((l) => l.startsWith("bun test"))).toBe(false);
    expect(r.left).toEqual(["sl-test-there-before"]);
  });

  test.skipIf(!CAN_START_PG)(
    "a real cluster it started is no longer running, and its directory is gone, after a failing step",
    () => {
      const r = verify("real", { FAKE_TEST: "fail" });
      expect(r.code).toBe(1);
      // "bun test" ran against a live cluster: it read the cluster's process id.
      expect(r.pid).toBeGreaterThan(1);
      // The process is gone, or exited and not yet reaped by its parent.
      expect(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(r.pid)]).stdout.toString().trim()).toMatch(/^(Z.*)?$/);
      expect(r.left).toEqual(["sl-test-there-before"]);
    },
    120_000,
  );
});

describe("bun run verify", () => {
  test("runs scripts/verify.sh with bash, which the script needs", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.verify).toBe("bash scripts/verify.sh");
  });
});

describe("CI", () => {
  test("runs on pull requests and on pushes to main and the release lines", () => {
    const ci = parseYamlText(readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8"), "ci.yml") as { on: { pull_request: unknown; push: { branches: string[] } } };
    expect(ci.on.push.branches).toEqual(["main", "release/**"]);
    expect("pull_request" in ci.on).toBe(true);
  });
});
