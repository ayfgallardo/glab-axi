import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { repoCommand, REPO_HELP } from "../../src/commands/repo.js";
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

function projectPayload(overrides: Record<string, unknown> = {}) {
  return {
    path_with_namespace: "group/sub/project",
    description: "widget factory",
    default_branch: "main",
    star_count: 3,
    forks_count: 1,
    open_issues_count: 5,
    visibility: "internal",
    web_url: "https://gitlab.example.com/group/sub/project",
    last_activity_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("repoCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await repoCommand(["--help"])).toBe(REPO_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await repoCommand([])).toBe(REPO_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await repoCommand(["unknown"]);
      expect(result).toContain("Unknown subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(
        repoCommand(["view", "--language", "ts"], ctx),
      ).rejects.toThrow(/unknown flag for glab-axi repo view: --language/);
      expect(mockedApi).not.toHaveBeenCalled();
    });
  });

  describe("view", () => {
    it("reads projects/:id and shapes the result", async () => {
      mockedApi.mockResolvedValueOnce(projectPayload());

      const result = await repoCommand(["view"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id"]);
      expect(result).toContain("group/sub/project");
      expect(result).toContain("internal");
    });
  });

  describe("create", () => {
    it("requires a name", async () => {
      await expect(repoCommand(["create"], ctx)).rejects.toThrow(
        "Repository name is required",
      );
    });

    it("builds glab repo create with visibility and description", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await repoCommand(
        ["create", "my-project", "--public", "--description", "hi"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "repo",
        "create",
        "my-project",
        "--public",
        "--description",
        "hi",
      ]);
      expect(result).toContain("created: ok");
    });
  });

  describe("edit", () => {
    it("targets the -R project when the context is not git-resolved", async () => {
      mockedExec.mockResolvedValueOnce("");

      await repoCommand(
        ["edit", "--description", "new", "--default-branch", "dev"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "repo",
        "update",
        "group/sub/project",
        "--description",
        "new",
        "--defaultBranch",
        "dev",
      ]);
    });

    it("rejects --archive combined with --unarchive", async () => {
      await expect(
        repoCommand(["edit", "--archive", "--unarchive"], ctx),
      ).rejects.toThrow("Choose either --archive or --unarchive");
    });
  });

  describe("clone", () => {
    it("requires a repo argument", async () => {
      await expect(repoCommand(["clone"])).rejects.toThrow(
        "Repository is required",
      );
    });

    it("passes the repo and optional dir to glab repo clone", async () => {
      mockedExec.mockResolvedValueOnce("");

      await repoCommand(["clone", "group/project", "mydir"]);

      expect(execArgsOf()).toEqual(["repo", "clone", "group/project", "mydir"]);
    });
  });

  describe("fork", () => {
    it("falls back to the current project when no repo is given", async () => {
      mockedExec.mockResolvedValueOnce("");

      await repoCommand(["fork", "--clone"], ctx);

      expect(execArgsOf()).toEqual([
        "repo",
        "fork",
        "group/sub/project",
        "--clone",
      ]);
    });
  });

  describe("list", () => {
    it("reads the membership projects endpoint with filters", async () => {
      mockedApi.mockResolvedValueOnce([projectPayload()]);

      const result = await repoCommand(
        ["list", "--visibility", "public", "--archived"],
        ctx,
      );

      const path = apiPathsOf()[0];
      expect(path).toContain("membership=true");
      expect(path).toContain("visibility=public");
      expect(path).toContain("archived=true");
      expect(result).toContain("count: 1");
    });
  });
});
