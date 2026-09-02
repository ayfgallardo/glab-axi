import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLI = "glab-axi";

/**
 * One invocation of the CLI. `raw` is what an agent would have ingested by
 * calling the GitLab API itself, `out` what it ingests through this CLI.
 * Only integers and the sub-command name are ever recorded — never arguments,
 * flag values, project paths, URLs or payload fragments.
 */
export interface GainEntry {
  ts: number;
  cli: string;
  cmd: string;
  raw: number;
  out: number;
  ms: number;
}

function dataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "axi");
  }
  if (process.platform === "win32") {
    return join(
      process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"),
      "axi",
    );
  }
  return join(
    process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"),
    "axi",
  );
}

export function gainLogPath(): string {
  return join(dataDir(), `${CLI}.jsonl`);
}

function enabled(): boolean {
  return process.env["AXI_GAIN"] !== "0";
}

let rawBodies: string[] = [];
let outputChunks: string[] = [];
let startedAt = 0;

export function startGain(): void {
  rawBodies = [];
  outputChunks = [];
  startedAt = Date.now();
}

/** Response body as an agent would have read it — decompressed, before parsing. */
export function recordRawBody(text: string): void {
  if (enabled()) {
    rawBodies.push(text);
  }
}

/** Tee the rendered output so it can be counted once the process is done writing. */
export function gainStdout<T extends { write: (chunk: string) => unknown }>(
  base: T,
): { write: (chunk: string) => unknown } {
  return {
    write(chunk: string) {
      if (enabled()) {
        outputChunks.push(chunk);
      }
      return base.write(chunk);
    },
  };
}

/**
 * Append the record for this invocation. Called after stdout is written so the
 * tokenizer — which loads large BPE tables — never delays the rendered output.
 * Nothing here may fail the command: unwritable directory, full disk or a
 * missing tokenizer all leave the exit code and the output untouched.
 */
export async function flushGain(cmd: string | undefined): Promise<void> {
  try {
    if (!enabled() || !cmd || rawBodies.length === 0) {
      return;
    }
    const ms = Date.now() - startedAt;
    const { countTokens } = await import("gpt-tokenizer/model/gpt-4o");
    const entry: GainEntry = {
      ts: Math.floor(Date.now() / 1000),
      cli: CLI,
      cmd,
      raw: countTokens(rawBodies.join("")),
      out: countTokens(outputChunks.join("")),
      ms,
    };
    const path = gainLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    return;
  }
}

/** Only a name the CLI itself defines is ever recorded, never user input. */
export function gainCommandName(
  argv: string[],
  known: readonly string[],
): string | undefined {
  const first = argv[0];
  if (first === undefined) {
    return "home";
  }
  return known.includes(first) ? first : undefined;
}

export function readGainLog(): GainEntry[] {
  let content: string;
  try {
    content = readFileSync(gainLogPath(), "utf-8");
  } catch {
    return [];
  }
  const entries: GainEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<GainEntry>;
      if (
        typeof parsed.cmd === "string" &&
        typeof parsed.raw === "number" &&
        typeof parsed.out === "number"
      ) {
        entries.push(parsed as GainEntry);
      }
    } catch {
      continue;
    }
  }
  return entries;
}
