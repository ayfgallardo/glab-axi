import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = { value: "" };

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home.value };
});

const {
  flushGain,
  gainCommandName,
  gainLogPath,
  gainStdout,
  readGainLog,
  recordRawBody,
  startGain,
} = await import("../src/gain.js");
const { gainCommand } = await import("../src/commands/gain.js");

const RAW = JSON.stringify([
  { iid: 42, title: "Corriger le calcul", author: { username: "fgallardo" } },
]);

/**
 * `dataDir()` picks a different branch per platform, so a runner only ever
 * exercises one of them. Stubbing the platform lets a single test cover both.
 */
function stubPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  return () => {
    Object.defineProperty(process, "platform", original as PropertyDescriptor);
  };
}

function readLines(): string[] {
  return readFileSync(gainLogPath(), "utf-8").trim().split("\n");
}

describe("gain recorder", () => {
  beforeEach(() => {
    home.value = mkdtempSync(join(tmpdir(), "glab-axi-gain-"));
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.stubEnv("LOCALAPPDATA", "");
    vi.stubEnv("AXI_GAIN", "");
    startGain();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home.value, { recursive: true, force: true });
  });

  it("stores the log under the platform data directory", () => {
    expect(gainLogPath().startsWith(home.value)).toBe(true);
    expect(gainLogPath().endsWith(join("axi", "glab-axi.jsonl"))).toBe(true);
  });

  it("records raw response tokens minus rendered output tokens", async () => {
    recordRawBody(RAW);
    gainStdout({ write: () => true }).write("mrs[1]{iid,title}:\n  42,...\n");

    await flushGain("mr");

    const entry = JSON.parse(readLines()[0]);
    expect(entry.cli).toBe("glab-axi");
    expect(entry.cmd).toBe("mr");
    expect(entry.raw).toBeGreaterThan(entry.out);
    expect(entry.out).toBeGreaterThan(0);
  });

  it("writes one append-only JSONL line per invocation", async () => {
    recordRawBody(RAW);
    await flushGain("mr");
    startGain();
    recordRawBody(RAW);
    await flushGain("issue");

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(Object.keys(JSON.parse(lines[0]))).toEqual([
      "ts",
      "cli",
      "cmd",
      "raw",
      "out",
      "ms",
    ]);
    const entry = JSON.parse(lines[1]);
    expect(entry.cmd).toBe("issue");
    expect(Number.isInteger(entry.ts)).toBe(true);
    expect(Number.isInteger(entry.ms)).toBe(true);
  });

  it("cumulates every API response of the invocation", async () => {
    recordRawBody(RAW);
    await flushGain("mr");
    const single = JSON.parse(readLines()[0]).raw;

    startGain();
    recordRawBody(RAW);
    recordRawBody(RAW);
    await flushGain("mr");

    expect(JSON.parse(readLines()[1]).raw).toBeGreaterThan(single);
  });

  it("records nothing when AXI_GAIN=0", async () => {
    vi.stubEnv("AXI_GAIN", "0");
    recordRawBody(RAW);
    gainStdout({ write: () => true }).write("out");

    await flushGain("mr");

    expect(readGainLog()).toEqual([]);
  });

  it("records nothing for an invocation that issued no request", async () => {
    await flushGain("setup");

    expect(readGainLog()).toEqual([]);
  });

  it("never leaks arguments, flag values or project paths", async () => {
    recordRawBody(RAW);
    gainStdout({ write: () => true }).write("mrs[0]:\n");

    await flushGain(
      gainCommandName(
        ["mr", "view", "42", "-R", "geofoncier/api-dossiers"],
        ["mr"],
      ),
    );

    const line = readLines()[0];
    for (const secret of [
      "view",
      "42",
      "-R",
      "geofoncier/api-dossiers",
      "fgallardo",
      "Corriger",
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it("only records a command name the CLI itself defines", () => {
    expect(gainCommandName([], ["mr"])).toBe("home");
    expect(gainCommandName(["mr"], ["mr"])).toBe("mr");
    expect(
      gainCommandName(["geofoncier/api-dossiers"], ["mr"]),
    ).toBeUndefined();
  });

  for (const platform of ["darwin", "linux"] as const) {
    it(`keeps the command output intact when the log cannot be written on ${platform}`, async () => {
      const restorePlatform = stubPlatform(platform);
      try {
        const stdout = {
          chunks: [] as string[],
          write(chunk: string) {
            this.chunks.push(chunk);
            return true;
          },
        };
        const tee = gainStdout(stdout);
        tee.write("rendered output\n");
        recordRawBody(RAW);
        // A plain file where the data directory belongs, derived from the very
        // path production uses, so the block survives a change of layout.
        const dataDir = dirname(gainLogPath());
        mkdirSync(dirname(dataDir), { recursive: true });
        writeFileSync(dataDir, "");

        await expect(flushGain("mr")).resolves.toBeUndefined();
        expect(stdout.chunks).toEqual(["rendered output\n"]);
        expect(process.exitCode).toBeUndefined();
      } finally {
        restorePlatform();
      }
    });
  }

  it("ignores malformed lines when reading the log", async () => {
    recordRawBody(RAW);
    await flushGain("mr");
    const path = gainLogPath();
    writeFileSync(path, `${readFileSync(path, "utf-8")}not json\n{}\n`);

    expect(readGainLog()).toHaveLength(1);
  });
});

describe("gain command", () => {
  beforeEach(() => {
    home.value = mkdtempSync(join(tmpdir(), "glab-axi-gain-cmd-"));
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.stubEnv("LOCALAPPDATA", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home.value, { recursive: true, force: true });
  });

  function seed(entries: object[]): void {
    const path = gainLogPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  }

  it("reports a clear message on an absent log", async () => {
    const output = await gainCommand();
    expect(output).toContain("no recorded invocation");
  });

  it("totals savings and breaks them down per sub-command", async () => {
    seed([
      {
        ts: 1788280000,
        cli: "glab-axi",
        cmd: "mr",
        raw: 400,
        out: 100,
        ms: 300,
      },
      {
        ts: 1788280100,
        cli: "glab-axi",
        cmd: "mr",
        raw: 600,
        out: 200,
        ms: 300,
      },
      {
        ts: 1788280200,
        cli: "glab-axi",
        cmd: "ci",
        raw: 9000,
        out: 1500,
        ms: 400,
      },
    ]);

    const output = await gainCommand();

    expect(output).toContain("invocations: 3");
    expect(output).toContain("raw_tokens: 10000");
    expect(output).toContain("out_tokens: 1800");
    expect(output).toContain("saved_tokens: 8200");
    expect(output).toContain("saved_pct: 82");
    expect(output).toContain("ci,1,9000,1500,7500,83.3");
    expect(output).toContain("mr,2,1000,300,700,70");
  });

  it("reports the oldest date without spreading the log into an argument list", async () => {
    seed(
      Array.from({ length: 200_000 }, (_, index) => ({
        ts: 1788280000 + index,
        cli: "glab-axi",
        cmd: "mr",
        raw: 2,
        out: 1,
        ms: 1,
      })),
    );

    const output = await gainCommand();

    expect(output).toContain("invocations: 200000");
    expect(output).toContain(
      `since: ${new Date(1788280000 * 1000).toISOString().slice(0, 10)}`,
    );
  });
});
