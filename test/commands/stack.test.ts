import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/glab.js", () => ({ glabRaw: vi.fn() }));

import { glabRaw } from "../../src/glab.js";
import { stackCommand, STACK_HELP } from "../../src/commands/stack.js";
import { AxiError, StackError } from "../../src/errors.js";

const mockedGlabRaw = vi.mocked(glabRaw);

describe("stackCommand", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns help without invoking glab", async () => {
    expect(await stackCommand([])).toBe(STACK_HELP);
    expect(mockedGlabRaw).not.toHaveBeenCalled();
  });

  it("creates a new stack", async () => {
    mockedGlabRaw.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "✓ Stack feature-api created\n",
    });

    const output = await stackCommand(["create", "feature-api"]);

    expect(mockedGlabRaw).toHaveBeenCalledWith([
      "stack",
      "create",
      "feature-api",
    ]);
    expect(output).toContain("status: ok");
    expect(output).toContain("Stack feature-api created");
  });

  it("requires a name for create", async () => {
    await expect(stackCommand(["create"])).rejects.toBeInstanceOf(AxiError);
    expect(mockedGlabRaw).not.toHaveBeenCalled();
  });

  it("requires -m/-d for save, never opening an editor", async () => {
    await expect(stackCommand(["save"])).rejects.toThrow(/-m\/--message/);
    expect(mockedGlabRaw).not.toHaveBeenCalled();
  });

  it("saves staged changes with a message", async () => {
    mockedGlabRaw.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await stackCommand(["save", "-a", "-m", "add endpoint"]);

    expect(mockedGlabRaw).toHaveBeenCalledWith([
      "stack",
      "save",
      "--all",
      "--message",
      "add endpoint",
    ]);
  });

  it("amends with -d as an alias for the message", async () => {
    mockedGlabRaw.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await stackCommand(["amend", "-d", "fix typo"]);

    expect(mockedGlabRaw).toHaveBeenCalledWith([
      "stack",
      "amend",
      "--message",
      "fix typo",
    ]);
  });

  it("forwards sync flags including repeatable ones", async () => {
    mockedGlabRaw.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await stackCommand([
      "sync",
      "--update-base",
      "--label",
      "bug",
      "--label",
      "priority::high",
      "--reviewer",
      "alice",
    ]);

    expect(mockedGlabRaw).toHaveBeenCalledWith([
      "stack",
      "sync",
      "--update-base",
      "--label",
      "bug",
      "--label",
      "priority::high",
      "--reviewer",
      "alice",
    ]);
  });

  it("lists stack entries", async () => {
    mockedGlabRaw.mockResolvedValue({
      exitCode: 0,
      stdout: "* feature-api\n  feature-model\n",
      stderr: "",
    });

    const output = await stackCommand(["list"]);

    expect(mockedGlabRaw).toHaveBeenCalledWith(["stack", "list"]);
    expect(output).toContain("feature-api");
    expect(output).toContain("feature-model");
  });

  it("switches to another stack", async () => {
    mockedGlabRaw.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await stackCommand(["switch", "feature-api"]);

    expect(mockedGlabRaw).toHaveBeenCalledWith([
      "stack",
      "switch",
      "feature-api",
    ]);
  });

  it.each(["next", "prev", "first", "last"])(
    "navigates with %s",
    async (nav) => {
      mockedGlabRaw.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await stackCommand([nav]);

      expect(mockedGlabRaw).toHaveBeenCalledWith(["stack", nav]);
    },
  );

  it.each(["move", "reorder"])(
    "rejects the interactive %s form before invoking glab",
    async (interactive) => {
      await expect(stackCommand([interactive])).rejects.toThrow(
        /interactive fuzzy finder/,
      );
      expect(mockedGlabRaw).not.toHaveBeenCalled();
    },
  );

  it("rejects an unrecognized subcommand", async () => {
    await expect(stackCommand(["bogus"])).rejects.toThrow(/Unknown/);
  });

  it("rejects an unknown flag", async () => {
    await expect(stackCommand(["list", "--short"])).rejects.toThrow(
      /unknown flag/,
    );
    expect(mockedGlabRaw).not.toHaveBeenCalled();
  });

  it("preserves the upstream exit code and reports diagnostics", async () => {
    mockedGlabRaw.mockResolvedValue({
      exitCode: 3,
      stdout: "",
      stderr: "rebase conflict in src/a.ts\n",
    });

    try {
      await stackCommand(["sync"]);
      expect.fail("expected StackError");
    } catch (error) {
      expect(error).toBeInstanceOf(StackError);
      expect((error as StackError).exitCode).toBe(3);
      expect((error as StackError).message).toContain("rebase conflict");
    }
  });
});
