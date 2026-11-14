#!/usr/bin/env bun
// The semantic-layer CLI. Run `bun sl.ts help` for the command list.
import { runCli } from "./lib/cli.ts";
import { processEnvironment } from "./lib/env-file.ts";

// process.exit does not wait for a pipe to take buffered output, so each stream's last write is
// awaited first; otherwise a large --json result read by a slow reader is cut short.
const last = new Map<NodeJS.WriteStream, Promise<void>>();
const writer = (stream: NodeJS.WriteStream) => (t: string) => {
  last.set(stream, new Promise<void>((done) => stream.write(`${t}\n`, () => done())));
};

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: processEnvironment(process.env, process.cwd()),
  out: writer(process.stdout),
  err: writer(process.stderr),
  stdin: () => Bun.stdin.text(),
});
await Promise.all(last.values());
process.exit(code);
