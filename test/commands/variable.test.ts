import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
  glabExecWithStdin: vi.fn(),
}));

vi.mock("../../src/stdin.js", () => ({
  readStdin: vi.fn(),
  isStdinTTY: vi.fn(),
}));

import { glabApiJson, glabExec, glabExecWithStdin } from "../../src/glab.js";
import { readStdin, isStdinTTY } from "../../src/stdin.js";
import { variableCommand, VARIABLE_HELP } from "../../src/commands/variable.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

const mockedApi = vi.mocked(glabApiJson);
const mockedExec = vi.mocked(glabExec);
const mockedExecStdin = vi.mocked(glabExecWithStdin);
const mockedReadStdin = vi.mocked(readStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);

const ctx: RepoContext = { fullPath: "group/sub/project", source: "flag" };

function apiPathsOf(): string[] {
  return mockedApi.mock.calls.map((call) => call[0] as string);
}

function execArgsOf(index = 0): string[] {
  return mockedExec.mock.calls[index][0] as string[];
}

function stdinCallOf(index = 0) {
  const call = mockedExecStdin.mock.calls[index];
  return { args: call[0] as string[], input: call[1] as string };
}

function variablePayload(overrides: Record<string, unknown> = {}) {
  return {
    key: "NODE_ENV",
    value: "production",
    masked: false,
    protected: false,
    environment_scope: "*",
    ...overrides,
  };
}

describe("variableCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("production");
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await variableCommand(["--help"])).toBe(VARIABLE_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await variableCommand([])).toBe(VARIABLE_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await variableCommand(["unknown"]);
      expect(result).toContain("Unknown subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(
        variableCommand(["set", "NAME", "--body", "value"], ctx),
      ).rejects.toThrow(/unknown flag for glab-axi variable set: --body/);
      expect(mockedApi).not.toHaveBeenCalled();
      expect(mockedExecStdin).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reads projects/:id/variables and prints values", async () => {
      mockedApi.mockResolvedValueOnce([variablePayload()]);

      const result = await variableCommand(["list"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/variables?per_page=100"]);
      expect(result).toContain("NODE_ENV");
      expect(result).toContain("production");
    });
  });

  describe("get", () => {
    it("requires a name", async () => {
      await expect(variableCommand(["get"], ctx)).rejects.toThrow(
        "Variable name is required",
      );
    });

    it("fetches a single variable, applying --scope as a filter query", async () => {
      mockedApi.mockResolvedValueOnce(variablePayload());

      await variableCommand(["get", "NODE_ENV", "--scope", "production"], ctx);

      expect(apiPathsOf()).toEqual([
        "projects/:id/variables/NODE_ENV?filter%5Benvironment_scope%5D=production",
      ]);
    });
  });

  describe("set", () => {
    it("requires a name", async () => {
      await expect(variableCommand(["set"], ctx)).rejects.toThrow(
        "Variable name is required",
      );
    });

    it("creates via glab variable set when the key does not exist yet, never putting the value in argv", async () => {
      mockedApi.mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND"));

      const result = await variableCommand(
        ["set", "NODE_ENV", "--masked", "--protected", "--scope", "prod"],
        ctx,
      );

      expect(apiPathsOf()).toEqual([
        "projects/:id/variables/NODE_ENV?filter%5Benvironment_scope%5D=prod",
      ]);
      const { args, input } = stdinCallOf();
      expect(args).toEqual([
        "variable",
        "set",
        "NODE_ENV",
        "--masked",
        "--protected",
        "--scope",
        "prod",
      ]);
      expect(args.join(" ")).not.toContain("production");
      expect(input).toBe("production");
      expect(result).toContain("set: created");
    });

    it("upserts via glab variable update when the key already exists, never putting the value in argv either", async () => {
      mockedApi.mockResolvedValueOnce(variablePayload());

      const result = await variableCommand(["set", "NODE_ENV"], ctx);

      const { args, input } = stdinCallOf();
      expect(args).toEqual(["variable", "update", "NODE_ENV"]);
      expect(args.join(" ")).not.toContain("production");
      expect(input).toBe("production");
      expect(result).toContain("set: updated");
    });

    it("re-throws a non-404 failure from the existence pre-check instead of guessing", async () => {
      mockedApi.mockRejectedValueOnce(new AxiError("boom", "FORBIDDEN"));

      await expect(variableCommand(["set", "NODE_ENV"], ctx)).rejects.toThrow(
        "boom",
      );
      expect(mockedExecStdin).not.toHaveBeenCalled();
    });

    it("throws when stdin is an interactive TTY", async () => {
      mockedApi.mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND"));
      mockedIsStdinTTY.mockReturnValue(true);

      await expect(variableCommand(["set", "NODE_ENV"], ctx)).rejects.toThrow(
        "variable value is required",
      );
      expect(mockedExecStdin).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("requires a name", async () => {
      await expect(variableCommand(["delete"], ctx)).rejects.toThrow(
        "Variable name is required",
      );
    });

    it("passes --scope through to glab variable delete", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await variableCommand(
        ["delete", "NODE_ENV", "--scope", "prod"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "variable",
        "delete",
        "NODE_ENV",
        "--scope",
        "prod",
      ]);
      expect(result).toContain("delete: ok");
    });
  });
});
