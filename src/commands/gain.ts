import { encode } from "@toon-format/toon";
import { gainLogPath, readGainLog, type GainEntry } from "../gain.js";
import { field, renderHelp, renderList, renderOutput } from "../toon.js";

export const GAIN_HELP = `usage: glab-axi gain
Token savings recorded by this CLI: raw GitLab API bodies minus rendered output.
flags[0]:
  (none)
env:
  AXI_GAIN=0 disables recording
examples:
  glab-axi gain
  glab-axi mr list && glab-axi gain
`;

interface Bucket {
  cmd: string;
  invocations: number;
  raw: number;
  out: number;
}

function savedPct(raw: number, out: number): number {
  return raw === 0 ? 0 : Number((((raw - out) / raw) * 100).toFixed(1));
}

/** Token savings recorded by this CLI: raw API JSON minus rendered output. */
export async function gainCommand(): Promise<string> {
  const entries = readGainLog();
  if (entries.length === 0) {
    return renderOutput([
      encode({ gain: "no recorded invocation", log: gainLogPath() }),
      renderHelp([
        "Run a read command (`glab-axi mr list`) to feed the log",
        "`AXI_GAIN=0` disables recording",
      ]),
    ]);
  }

  const buckets = new Map<string, Bucket>();
  let raw = 0;
  let out = 0;
  for (const entry of entries) {
    raw += entry.raw;
    out += entry.out;
    const bucket = buckets.get(entry.cmd) ?? {
      cmd: entry.cmd,
      invocations: 0,
      raw: 0,
      out: 0,
    };
    bucket.invocations++;
    bucket.raw += entry.raw;
    bucket.out += entry.out;
    buckets.set(entry.cmd, bucket);
  }

  const rows = [...buckets.values()]
    .sort((a, b) => b.raw - b.out - (a.raw - a.out))
    .map((bucket) => ({
      ...bucket,
      saved: bucket.raw - bucket.out,
      saved_pct: savedPct(bucket.raw, bucket.out),
    }));

  return renderOutput([
    encode({
      gain: {
        invocations: entries.length,
        raw_tokens: raw,
        out_tokens: out,
        saved_tokens: raw - out,
        saved_pct: savedPct(raw, out),
        since: sinceIso(entries),
      },
    }),
    renderList("by_command", rows, [
      field("cmd"),
      field("invocations"),
      field("raw"),
      field("out"),
      field("saved"),
      field("saved_pct"),
    ]),
    renderHelp([`Log: ${gainLogPath()}`]),
  ]);
}

/**
 * Reduced rather than `Math.min(...entries.map(…))`: the log is append-only and
 * unbounded, and spreading a few hundred thousand arguments throws a RangeError.
 */
function sinceIso(entries: GainEntry[]): string {
  const oldest = entries.reduce(
    (min, entry) => (entry.ts < min ? entry.ts : min),
    Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(oldest)
    ? new Date(oldest * 1000).toISOString().slice(0, 10)
    : "unknown";
}
