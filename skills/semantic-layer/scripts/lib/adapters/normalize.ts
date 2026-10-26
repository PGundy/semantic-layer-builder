export function normalizeInteger(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  return v;
}

export function normalizeDecimal(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatTimestamp(d: Date): string {
  const ms = d.getUTCMilliseconds();
  const base = `${formatDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${base}.${pad(ms, 3)}` : base;
}
