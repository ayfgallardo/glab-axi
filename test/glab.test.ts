import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import {
  glabJson,
  glabExec,
  glabRaw,
  glabExecWithStdin,
  glabApiJson,
  glabApiText,
} from "../src/glab.js";
import type { RepoContext } from "../src/context.js";
import { AxiError } from "../src/errors.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);
type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

/** Helper to make mockedExecFile call its callback with specified values. */
function mockExecFileResult(
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) {
  mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(error, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Helper to make mockedExecFile call its callback and capture what was written to child.stdin. */
function mockExecFileResultWithStdin(
  error: (Error & { code?: string | number }) | null,
  stdout: string,
  stderr: string,
) {
  const stdinEnd = vi.fn();
  mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(error, stdout, stderr);
    return { stdin: { end: stdinEnd } } as unknown as ReturnType<
      typeof execFile
    >;
  });
  return stdinEnd;
}

/** Helper to simulate ENOENT (glab not installed). */
function mockExecFileEnoent() {
  mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = new Error("spawn glab ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    (callback as ExecFileCallback)(err, "", "");
    return {} as ReturnType<typeof execFile>;
  });
}

function callArgs(index = 0): string[] {
  return mockedExecFile.mock.calls[index][1] as string[];
}

function callOptions(index = 0): { env?: NodeJS.ProcessEnv } {
  return mockedExecFile.mock.calls[index][2] as { env?: NodeJS.ProcessEnv };
}

describe("glabJson", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("invokes the glab binary", async () => {
    mockExecFileResult(null, "[]", "");
    await glabJson(["issue", "list"]);
    expect(mockedExecFile.mock.calls[0][0]).toBe("glab");
  });

  it("parses JSON output correctly", async () => {
    mockExecFileResult(null, '{"iid": 1, "title": "test"}', "");
    const result = await glabJson<{ iid: number; title: string }>([
      "issue",
      "view",
      "1",
      "--output",
      "json",
    ]);
    expect(result).toEqual({ iid: 1, title: "test" });
  });

  it("throws on non-zero exit code", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResult(error, "", "glab: 404 Not Found (HTTP 404)");
    await expect(glabJson(["issue", "view", "42"])).rejects.toThrow(AxiError);
    try {
      mockExecFileResult(error, "", "glab: 404 Not Found (HTTP 404)");
      await glabJson(["issue", "view", "42"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("NOT_FOUND");
    }
  });

  it("throws on invalid JSON", async () => {
    mockExecFileResult(null, "not json at all", "");
    await expect(glabJson(["issue", "list"])).rejects.toThrow(AxiError);
    try {
      mockExecFileResult(null, "not json at all", "");
      await glabJson(["issue", "list"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("UNKNOWN");
      expect((e as AxiError).message).toContain("Unexpected glab output");
    }
  });

  it("throws glabNotInstalledError on ENOENT", async () => {
    mockExecFileEnoent();
    await expect(glabJson(["issue", "list"])).rejects.toThrow(AxiError);
    try {
      mockExecFileEnoent();
      await glabJson(["issue", "list"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("GLAB_NOT_INSTALLED");
    }
  });

  it("appends -R for non-git sources", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "flag" };
    await glabJson(["issue", "list"], ctx);
    expect(callArgs()).toEqual(["issue", "list", "-R", "group/project"]);
  });

  it("passes a nested group path through -R unchanged", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = {
      fullPath: "group/subgroup/project",
      source: "flag",
    };
    await glabJson(["issue", "list"], ctx);
    expect(callArgs()).toContain("group/subgroup/project");
  });

  it("does not append -R for git source", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "git" };
    await glabJson(["issue", "list"], ctx);
    expect(callArgs()).not.toContain("-R");
  });

  it("sets GITLAB_HOST in the child env when the context carries a host", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = {
      fullPath: "group/project",
      source: "flag",
      host: { value: "gitlab.example.com", source: "flag" },
    };
    await glabJson(["issue", "list"], ctx);
    expect(callOptions().env?.["GITLAB_HOST"]).toBe("gitlab.example.com");
  });

  it("leaves the child env untouched when no host is configured", async () => {
    mockExecFileResult(null, "[]", "");
    await glabJson(["issue", "list"]);
    expect(callOptions().env).toBeUndefined();
  });
});

describe("glabExec", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns stdout on success", async () => {
    mockExecFileResult(null, "output text", "");
    const result = await glabExec(["issue", "create"]);
    expect(result).toBe("output text");
  });

  it("throws on non-zero exit code", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResult(error, "", "glab: 403 Forbidden (HTTP 403)");
    await expect(glabExec(["issue", "create"])).rejects.toThrow(AxiError);
    try {
      mockExecFileResult(error, "", "glab: 403 Forbidden (HTTP 403)");
      await glabExec(["issue", "create"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("FORBIDDEN");
    }
  });

  it("throws glabNotInstalledError on ENOENT", async () => {
    mockExecFileEnoent();
    await expect(glabExec(["version"])).rejects.toThrow(AxiError);
    try {
      mockExecFileEnoent();
      await glabExec(["version"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("GLAB_NOT_INSTALLED");
    }
  });

  it("appends -R for non-git sources", async () => {
    mockExecFileResult(null, "output", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "flag" };
    await glabExec(["release", "create", "v1.0.0"], ctx);
    expect(callArgs()).toEqual([
      "release",
      "create",
      "v1.0.0",
      "-R",
      "group/project",
    ]);
  });
});

describe("glabRaw", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns full result without throwing on non-zero exit", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResult(error, "some output", "some error");
    const result = await glabRaw(["stack", "list"]);
    expect(result.stdout).toBe("some output");
    expect(result.stderr).toBe("some error");
    expect(result.exitCode).toBe(1);
  });

  it("returns result on success", async () => {
    mockExecFileResult(null, "output", "");
    const result = await glabRaw(["stack", "list"]);
    expect(result.stdout).toBe("output");
    expect(result.exitCode).toBe(0);
  });

  it("throws glabNotInstalledError on ENOENT", async () => {
    mockExecFileEnoent();
    await expect(glabRaw(["version"])).rejects.toThrow(AxiError);
    try {
      mockExecFileEnoent();
      await glabRaw(["version"]);
    } catch (e) {
      expect((e as AxiError).code).toBe("GLAB_NOT_INSTALLED");
    }
  });

  it("appends -R for env source", async () => {
    mockExecFileResult(null, "output", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "env" };
    await glabRaw(["ci", "list"], ctx);
    expect(callArgs()).toEqual(["ci", "list", "-R", "group/project"]);
  });
});

describe("glabExecWithStdin", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("writes input to the child process stdin and returns stdout", async () => {
    const stdinEnd = mockExecFileResultWithStdin(null, "ok", "");
    const result = await glabExecWithStdin(["variable", "set", "FOO"], "shh");
    expect(result).toBe("ok");
    expect(stdinEnd).toHaveBeenCalledWith("shh");
  });

  it("never passes the input value as a CLI argument", async () => {
    mockExecFileResultWithStdin(null, "ok", "");
    await glabExecWithStdin(["variable", "set", "FOO"], "super-secret-value");
    expect(callArgs()).not.toContain("super-secret-value");
  });

  it("throws on non-zero exit code", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResultWithStdin(error, "", "glab: 403 Forbidden (HTTP 403)");
    await expect(
      glabExecWithStdin(["variable", "set", "FOO"], "shh"),
    ).rejects.toThrow(AxiError);
  });

  it("throws glabNotInstalledError on ENOENT", async () => {
    const stdinEnd = vi.fn();
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("spawn glab ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      (callback as ExecFileCallback)(err, "", "");
      return { stdin: { end: stdinEnd } } as unknown as ReturnType<
        typeof execFile
      >;
    });
    await expect(
      glabExecWithStdin(["variable", "set", "FOO"], "shh"),
    ).rejects.toThrow(AxiError);
  });

  it("appends -R for non-git sources", async () => {
    const stdinEnd = mockExecFileResultWithStdin(null, "ok", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "flag" };
    await glabExecWithStdin(["variable", "set", "FOO"], "shh", ctx);
    expect(callArgs()).toEqual([
      "variable",
      "set",
      "FOO",
      "-R",
      "group/project",
    ]);
    expect(stdinEnd).toHaveBeenCalledWith("shh");
  });
});

describe("glabApiJson", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("substitutes :id with the URL-encoded project path", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = {
      fullPath: "group/subgroup/project",
      source: "git",
    };
    await glabApiJson("projects/:id/issues", { ctx });
    expect(callArgs()).toEqual([
      "api",
      "projects/group%2Fsubgroup%2Fproject/issues",
    ]);
  });

  it("never passes -R, which glab api rejects", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "flag" };
    await glabApiJson("projects/:id/issues", { ctx });
    expect(callArgs()).not.toContain("-R");
  });

  it("leaves :id for glab to resolve when no context is available", async () => {
    mockExecFileResult(null, "[]", "");
    await glabApiJson("projects/:id/issues");
    expect(callArgs()).toEqual(["api", "projects/:id/issues"]);
  });

  it("passes the HTTP method through --method", async () => {
    mockExecFileResult(null, "{}", "");
    await glabApiJson("projects/1/issues/2", { method: "PUT" });
    expect(callArgs()).toEqual([
      "api",
      "projects/1/issues/2",
      "--method",
      "PUT",
    ]);
  });

  it("sends string fields as --raw-field and typed fields as --field", async () => {
    mockExecFileResult(null, "{}", "");
    await glabApiJson("projects/1/issues", {
      method: "POST",
      fields: { title: "42", confidential: true, weight: 3 },
    });
    expect(callArgs()).toEqual([
      "api",
      "projects/1/issues",
      "--method",
      "POST",
      "--raw-field",
      "title=42",
      "--field",
      "confidential=true",
      "--field",
      "weight=3",
    ]);
  });

  it("sets GITLAB_HOST in the child env when the context carries a host", async () => {
    mockExecFileResult(null, "[]", "");
    const ctx: RepoContext = {
      fullPath: "group/project",
      source: "git",
      host: { value: "gitlab.example.com", source: "flag" },
    };
    await glabApiJson("projects/:id", { ctx });
    expect(callOptions().env?.["GITLAB_HOST"]).toBe("gitlab.example.com");
  });

  it("maps glab api errors through mapGlabError", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResult(
      error,
      '{"message":"404 Project Not Found"}',
      "glab: 404 Project Not Found (HTTP 404)",
    );
    try {
      await glabApiJson("projects/:id");
      expect.unreachable();
    } catch (e) {
      expect((e as AxiError).code).toBe("REPO_NOT_FOUND");
    }
  });
});

describe("glabApiText", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
  });

  it("returns the raw body of a non-JSON endpoint", async () => {
    mockExecFileResult(null, "$ pytest\nFAILED test_x\n", "");
    const ctx: RepoContext = { fullPath: "group/project", source: "flag" };
    const trace = await glabApiText("projects/:id/jobs/7/trace", { ctx });
    expect(trace).toBe("$ pytest\nFAILED test_x\n");
    expect(callArgs()).toEqual([
      "api",
      "projects/group%2Fproject/jobs/7/trace",
    ]);
  });

  it("maps glab api errors through mapGlabError", async () => {
    const error = new Error("exit 1") as Error & { code: number };
    error.code = 1;
    mockExecFileResult(error, "", "glab: 404 Not Found (HTTP 404)");
    try {
      await glabApiText("projects/1/jobs/7/trace");
      expect.unreachable();
    } catch (e) {
      expect((e as AxiError).code).toBe("NOT_FOUND");
    }
  });
});
