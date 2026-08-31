import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  encodedProjectId,
  resolveCurrentBranch,
  resolveRepo,
} from "../src/context.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("resolveRepo", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["GITLAB_REPO"];
    delete process.env["GITLAB_HOST"];
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when no repo is available", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(resolveRepo()).toBeUndefined();
  });

  it("parses flag value correctly", () => {
    const result = resolveRepo("gitlab-org/cli");
    expect(result).toEqual({ fullPath: "gitlab-org/cli", source: "flag" });
    // Should not call git when flag is provided
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("accepts nested group paths", () => {
    expect(resolveRepo("group/subgroup/project")).toEqual({
      fullPath: "group/subgroup/project",
      source: "flag",
    });
  });

  it("returns undefined for invalid flag value", () => {
    expect(resolveRepo("invalid")).toBeUndefined();
    expect(resolveRepo("/name")).toBeUndefined();
    expect(resolveRepo("owner/")).toBeUndefined();
    expect(resolveRepo("group//project")).toBeUndefined();
  });

  it("uses the GITLAB_REPO env var", () => {
    process.env["GITLAB_REPO"] = "gitlab-org/cli";
    const result = resolveRepo();
    expect(result).toEqual({ fullPath: "gitlab-org/cli", source: "env" });
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("parses SSH git remote URLs", () => {
    mockedExecFileSync.mockReturnValue("git@gitlab.com:gitlab-org/cli.git\n");
    expect(resolveRepo()).toEqual({
      fullPath: "gitlab-org/cli",
      source: "git",
    });
  });

  it("parses SSH git remote URLs without .git suffix", () => {
    mockedExecFileSync.mockReturnValue("git@gitlab.com:group/project\n");
    expect(resolveRepo()).toEqual({ fullPath: "group/project", source: "git" });
  });

  it("parses SSH remotes with nested groups", () => {
    mockedExecFileSync.mockReturnValue(
      "git@gitlab.com:group/subgroup/project.git\n",
    );
    expect(resolveRepo()).toEqual({
      fullPath: "group/subgroup/project",
      source: "git",
    });
  });

  it("parses HTTPS git remote URLs", () => {
    mockedExecFileSync.mockReturnValue(
      "https://gitlab.com/gitlab-org/cli.git\n",
    );
    expect(resolveRepo()).toEqual({
      fullPath: "gitlab-org/cli",
      source: "git",
    });
  });

  it("parses HTTPS remotes with nested groups", () => {
    mockedExecFileSync.mockReturnValue(
      "https://gitlab.com/group/subgroup/project\n",
    );
    expect(resolveRepo()).toEqual({
      fullPath: "group/subgroup/project",
      source: "git",
    });
  });

  it("prioritizes flag over env and git", () => {
    process.env["GITLAB_REPO"] = "env-group/env-project";
    mockedExecFileSync.mockReturnValue("git@gitlab.com:git-group/git-proj.git");
    const result = resolveRepo("flag-group/flag-project");
    expect(result!.source).toBe("flag");
    expect(result!.fullPath).toBe("flag-group/flag-project");
  });

  it("prioritizes env over git", () => {
    process.env["GITLAB_REPO"] = "env-group/env-project";
    mockedExecFileSync.mockReturnValue("git@gitlab.com:git-group/git-proj.git");
    const result = resolveRepo();
    expect(result!.source).toBe("env");
    expect(result!.fullPath).toBe("env-group/env-project");
  });

  it("parses SSH remotes on a self-managed host from GITLAB_HOST", () => {
    process.env["GITLAB_HOST"] = "git.example.com";
    mockedExecFileSync.mockReturnValue("git@git.example.com:group/project.git");
    expect(resolveRepo()).toEqual({ fullPath: "group/project", source: "git" });
  });

  it("parses HTTPS remotes on a self-managed host from GITLAB_HOST", () => {
    process.env["GITLAB_HOST"] = "git.example.com";
    mockedExecFileSync.mockReturnValue(
      "https://git.example.com/group/project.git",
    );
    expect(resolveRepo()).toEqual({ fullPath: "group/project", source: "git" });
  });

  it("does not match a gitlab.com remote when GITLAB_HOST names another host", () => {
    process.env["GITLAB_HOST"] = "git.example.com";
    mockedExecFileSync.mockReturnValue("git@gitlab.com:group/project.git");
    expect(resolveRepo()).toBeUndefined();
  });

  it("does not match a subdomain-prefixed remote host", () => {
    process.env["GITLAB_HOST"] = "git.example.com";
    mockedExecFileSync.mockReturnValue(
      "git@old-git.example.com:group/project.git",
    );
    expect(resolveRepo()).toBeUndefined();
  });
});

describe("encodedProjectId", () => {
  it("URL-encodes the slashes of a nested project path", () => {
    expect(encodedProjectId({ fullPath: "a/b/c", source: "git" })).toBe(
      "a%2Fb%2Fc",
    );
  });
});

describe("resolveCurrentBranch", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  it("returns the checked-out branch", () => {
    mockedExecFileSync.mockReturnValue("feat/pipelines\n");
    expect(resolveCurrentBranch()).toBe("feat/pipelines");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      expect.anything(),
    );
  });

  it("returns undefined on a detached HEAD", () => {
    mockedExecFileSync.mockReturnValue("\n");
    expect(resolveCurrentBranch()).toBeUndefined();
  });

  it("returns undefined outside a git repository", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(resolveCurrentBranch()).toBeUndefined();
  });
});
