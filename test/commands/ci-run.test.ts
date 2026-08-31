import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { ciCommand } from "../../src/commands/ci.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

// Deliberately does NOT mock src/glab.js: this exercises the real `ci run` path
// through glab.ts and the error classifier, stubbing only the glab boundary.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);
type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

/** Capture the argv handed to glab, and reply with a canned exit/stdout/stderr. */
function stubGlab(
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
): { argv: () => string[] } {
  let seen: string[] = [];
  mockedExecFile.mockImplementation((_cmd, args, _opts, callback) => {
    seen = args as string[];
    (callback as ExecFileCallback)(error, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
  return { argv: () => seen };
}

function glabFailure(): Error & { code: number } {
  return Object.assign(new Error("glab exited 1"), { code: 1 });
}

const ctx: RepoContext = { fullPath: "group/sub/project", source: "flag" };

describe("ci run through the real glab layer", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("appends -R and reports the triggered pipeline", async () => {
    const glab = stubGlab(
      null,
      "Created pipeline (id: 52378), status: created, ref: main, weburl: https://gitlab.example.com/group/sub/project/-/pipelines/52378\n",
      "",
    );

    const result = await ciCommand(["run", "--ref", "main"], ctx);

    expect(result).toContain("52378");
    expect(glab.argv()).toEqual([
      "ci",
      "run",
      "--branch",
      "main",
      "-R",
      "group/sub/project",
    ]);
  });

  // glab renders errors in a padded box, so the classifier must read the cleaned
  // text rather than the raw first line.
  it("classifies a boxed 403 from glab as FORBIDDEN", async () => {
    stubGlab(
      glabFailure(),
      "",
      "\nERROR\n\n  glab: POST https://gitlab.example.com/api/v4/projects/145/pipeline: 403 {message: 403 Forbidden}\n",
    );

    const err = await ciCommand(["run"], ctx).catch(
      (e: unknown) => e as AxiError,
    );

    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("FORBIDDEN");
  });
});
