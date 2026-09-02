import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = { value: "" };

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => home.value };
});

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const { flushGain, gainLogPath, startGain } = await import("../src/gain.js");
const { glabApiJson, glabExec } = await import("../src/glab.js");

const mockedExecFile = vi.mocked(execFile);
type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const BODY = JSON.stringify([
  { iid: 7, title: "Ajouter un index sur dossier_id" },
]);

function mockGlab(
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr = "",
) {
  mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(error, stdout, stderr);
    return { stdin: { end: vi.fn() } } as unknown as ReturnType<
      typeof execFile
    >;
  });
}

function recordedRaw(): number {
  const line = readFileSync(gainLogPath(), "utf-8").trim().split("\n")[0];
  return JSON.parse(line).raw;
}

describe("what the recorder counts at the glab boundary", () => {
  beforeEach(() => {
    home.value = mkdtempSync(join(tmpdir(), "glab-axi-gain-boundary-"));
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.stubEnv("LOCALAPPDATA", "");
    vi.stubEnv("AXI_GAIN", "");
    mockedExecFile.mockReset();
    startGain();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home.value, { recursive: true, force: true });
  });

  it("counts a GitLab API body once per response", async () => {
    mockGlab(null, BODY);
    await glabApiJson("projects/:id/merge_requests");
    await flushGain("mr");
    const single = recordedRaw();

    startGain();
    await glabApiJson("projects/:id/merge_requests");
    await glabApiJson("projects/:id/issues");
    await flushGain("mr");

    const { countTokens } = await import("gpt-tokenizer/model/gpt-4o");
    const lines = readFileSync(gainLogPath(), "utf-8").trim().split("\n");
    expect(single).toBe(countTokens(BODY));
    expect(JSON.parse(lines[1]).raw).toBe(countTokens(BODY + BODY));
  });

  it("ignores the output of a glab subcommand, which is glab's own rendering", async () => {
    mockGlab(
      null,
      "https://gitlab.example.com/group/project/-/merge_requests/7\n",
    );
    await glabExec(["mr", "create", "--yes"]);
    await flushGain("mr");

    expect(() => readFileSync(gainLogPath(), "utf-8")).toThrow();
  });

  it("counts the error body of a failed API call, which has no retry behind it", async () => {
    const error = new Error("failed") as Error & { code: number };
    error.code = 1;
    mockGlab(error, "", 'glab: 404 {"message":"404 Project Not Found"}');
    await expect(glabApiJson("projects/:id/merge_requests")).rejects.toThrow();
    await flushGain("mr");

    expect(recordedRaw()).toBeGreaterThan(0);
  });
});
