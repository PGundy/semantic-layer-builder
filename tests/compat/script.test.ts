import { expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "compat-pg.sh");
const run = (...args: string[]) => Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });

test("compat-pg.sh asks for one major version number before it touches Docker", () => {
  for (const args of [[], ["14", "15"], ["14.1"], ["latest"]]) {
    const r = run(...args);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/^compat-pg: /);
  }
  expect(run("latest").stderr.toString()).toContain("major number");
});

const NETWORK = join(import.meta.dir, "..", "..", "scripts", "compat-network.sh");

test("compat-network.sh takes no arguments and a numeric COMPAT_NET_PORT, checked before it touches Docker", () => {
  const net = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(["bash", NETWORK, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const extra = net(["16"]);
  expect(extra.exitCode).toBe(1);
  expect(extra.stderr.toString()).toMatch(/^compat-network: usage/);
  const port = net([], { COMPAT_NET_PORT: "55x" });
  expect(port.exitCode).toBe(1);
  expect(port.stderr.toString()).toContain('COMPAT_NET_PORT is a port number such as 55442, not "55x"');
});
