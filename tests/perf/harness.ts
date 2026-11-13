// Runs the CLI as its own process, the way an agent does, and records the wall time and the
// process's peak resident memory.
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXED_NOW, tempDir } from "../helpers.ts";

// SL_PERF_CLI points the suite at another copy of sl.ts, such as the base branch's, to compare.
export const SL = process.env.SL_PERF_CLI ?? join(import.meta.dir, "..", "..", "skills", "semantic-layer", "scripts", "sl.ts");

export interface Timed {
  code: number;
  out: string;
  err: string;
  ms: number;
  // Peak resident set size of the CLI process, in bytes.
  maxRss: number;
}

const PRELOAD = join(import.meta.dir, "rss-preload.ts");

// The process reports its own peak memory (rss-preload.ts); what the parent reads for the child
// is the fallback when that report is missing.
export async function timedSl(root: string, args: string[], env: Record<string, string> = {}): Promise<Timed> {
  const rssFile = join(tempDir("perf-rss"), "rss");
  const start = performance.now();
  const proc = Bun.spawn(["bun", "--preload", PRELOAD, SL, ...args, "--root", root], {
    cwd: root,
    env: { ...process.env, SL_NOW: FIXED_NOW, SL_PERF_RSS_FILE: rssFile, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const ms = performance.now() - start;
  let own = 0;
  try {
    own = Number(readFileSync(rssFile, "utf8"));
  } catch {
    own = 0;
  }
  rmSync(dirname(rssFile), { recursive: true, force: true });
  const maxRss = own > 0 ? own : (proc.resourceUsage()?.maxRSS ?? 0);
  return { code, out, err, ms, maxRss };
}

// Throws with the command's output unless it exited 0.
export function ok(r: Timed, what: string): Timed {
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}:\n${r.err}\n${r.out.slice(0, 2000)}`);
  return r;
}

export function mb(bytes: number): string {
  return `${Math.round(bytes / 1048576)} MB`;
}

// One line per measured step, printed so a run records its numbers.
export function report(label: string, r: Timed): void {
  console.log(`perf: ${label.padEnd(36)} ${(r.ms / 1000).toFixed(2).padStart(7)} s  ${mb(r.maxRss).padStart(8)}`);
}

// A table-list file of `lines` entries in the selection grammar: comments, exact names, globs,
// regexes and ! excludes, over the synthetic catalog's names.
export function tableListText(lines: number): string {
  const out = ["# Synthetic table-list file for the performance suite."];
  const schemas = ["sales", "finance", "ops", "marketing", "product"];
  for (let i = 0; out.length < lines; i++) {
    const n = String(i * 97).padStart(5, "0");
    const s = schemas[i % schemas.length]!;
    switch (i % 5) {
      case 0:
        out.push(`${s}.fct_*_${n}`);
        break;
      case 1:
        out.push(`dim_orders_${n}`);
        break;
      case 2:
        out.push(`re:${s}\\.rpt_[a-z_]+_${n.slice(0, 3)}\\d\\d`);
        break;
      case 3:
        out.push(`!*_${n}_2019`);
        break;
      default:
        out.push(`# entry ${i}`);
    }
  }
  return `${out.join("\n")}\n`;
}
