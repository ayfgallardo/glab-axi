import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { labelCommand, LABEL_HELP } from "../../src/commands/label.js";
import type { RepoContext } from "../../src/context.js";

const mockedApi = vi.mocked(glabApiJson);
const mockedExec = vi.mocked(glabExec);

const ctx: RepoContext = { fullPath: "group/sub/project", source: "flag" };

function apiPathsOf(): string[] {
  return mockedApi.mock.calls.map((call) => call[0] as string);
}

function execArgsOf(index = 0): string[] {
  return mockedExec.mock.calls[index][0] as string[];
}

describe("labelCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await labelCommand(["--help"])).toBe(LABEL_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await labelCommand([])).toBe(LABEL_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await labelCommand(["unknown"]);
      expect(result).toContain("Unknown subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(labelCommand(["list", "--all"], ctx)).rejects.toThrow(
        /unknown flag for glab-axi label list: --all/,
      );
      expect(mockedApi).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reads projects/:id/labels with the clamped per_page limit", async () => {
      mockedApi.mockResolvedValueOnce([
        { name: "bug", color: "#d9534f", description: "Bug" },
      ]);

      const result = await labelCommand(["list"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/labels?per_page=100"]);
      expect(result).toContain("bug");
    });

    it("clamps --limit to 100", async () => {
      mockedApi.mockResolvedValueOnce([]);

      await labelCommand(["list", "--limit", "500"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/labels?per_page=100"]);
    });
  });

  describe("create", () => {
    it("requires --name and --color", async () => {
      await expect(labelCommand(["create"], ctx)).rejects.toThrow(
        "--name is required",
      );
      await expect(
        labelCommand(["create", "--name", "bug"], ctx),
      ).rejects.toThrow("--color is required");
    });

    it("calls glab label create with the given flags", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await labelCommand(
        ["create", "--name", "bug", "--color", "#ff0000", "--description", "d"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "label",
        "create",
        "--name",
        "bug",
        "--color",
        "#ff0000",
        "--description",
        "d",
      ]);
      expect(result).toContain("created: ok");
    });
  });

  describe("edit", () => {
    it("requires a label name positional", async () => {
      await expect(labelCommand(["edit"], ctx)).rejects.toThrow(
        "Label name is required",
      );
    });

    it("maps --name to --new-name and passes --label-id", async () => {
      mockedExec.mockResolvedValueOnce("");

      await labelCommand(["edit", "bug", "--name", "critical-bug"], ctx);

      expect(execArgsOf()).toEqual([
        "label",
        "edit",
        "--label-id",
        "bug",
        "--new-name",
        "critical-bug",
      ]);
    });

    it("does not swallow the label name when a valued flag comes before it", async () => {
      mockedExec.mockResolvedValueOnce("");

      await labelCommand(["edit", "--color", "#ff0000", "bug"], ctx);

      expect(execArgsOf()).toEqual([
        "label",
        "edit",
        "--label-id",
        "bug",
        "--color",
        "#ff0000",
      ]);
    });
  });

  describe("delete", () => {
    it("requires a label name positional", async () => {
      await expect(labelCommand(["delete"], ctx)).rejects.toThrow(
        "Label name is required",
      );
    });

    it("calls glab label delete", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await labelCommand(["delete", "bug"], ctx);

      expect(execArgsOf()).toEqual(["label", "delete", "bug"]);
      expect(result).toContain("delete: ok");
    });
  });
});
