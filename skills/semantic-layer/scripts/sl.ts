#!/usr/bin/env bun
// The semantic-layer CLI. Run `bun sl.ts help` for the command list.
import { runCli } from "./lib/cli.ts";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
});
process.exit(code);
