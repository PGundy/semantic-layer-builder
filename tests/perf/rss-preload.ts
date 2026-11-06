// Preloaded into each CLI process the performance suite runs: at exit it writes the process's
// peak resident memory, in bytes, to the file SL_PERF_RSS_FILE names.
import { writeFileSync } from "node:fs";

const file = process.env.SL_PERF_RSS_FILE;
if (file) process.on("exit", () => writeFileSync(file, String(process.resourceUsage().maxRSS * 1024)));
