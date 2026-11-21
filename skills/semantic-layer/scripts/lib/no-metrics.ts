// The owner's answer that they report no metrics for now (spec: metrics.yaml, No metrics for now):
// metrics.yaml's no_metrics, written by semlayer add-metric --none with the owner's name and words. It
// closes the metrics phase while metrics.yaml lists no metric; once one is listed, that metric is
// read back as any other and the answer no longer applies.
import { plainText } from "./output.ts";

export interface NoMetrics {
  // Who said it, and their words, each one line, credentials redacted.
  by: string;
  text: string;
  // The day it was recorded, YYYY-MM-DD.
  at: string;
}

// As semlayer status --json reports it: the record, and whether it applies (metrics.yaml lists no metric).
export interface NoMetricsStatus extends NoMetrics {
  applies: boolean;
}

// The record of a loaded metrics.yaml, or null when it has none or it is not one.
export function noMetrics(file: unknown): NoMetrics | null {
  const v = file && typeof file === "object" ? (file as { no_metrics?: unknown }).no_metrics : undefined;
  if (!v || typeof v !== "object") return null;
  const { by, text, at } = v as Record<string, unknown>;
  return typeof by === "string" && by && typeof text === "string" && text && typeof at === "string" ? { by, text, at } : null;
}

// The status line: "metrics: none for now, said by <owner> on <date>", or why it no longer applies;
// the owner's words are in semlayer status --json.
export function noMetricsLine(n: NoMetricsStatus): string {
  const who = `${plainText(n.by)} on ${n.at}`;
  return n.applies
    ? `metrics: none for now, said by ${who}`
    : `metrics: the owner's none for now (said by ${who}) no longer applies, since metrics.yaml lists metrics`;
}

// The command that records the answer, as a step names it.
export const NO_METRICS_COMMAND = 'semlayer add-metric --none --by "<owner>" --text "<the owner\'s words>"';
