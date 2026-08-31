import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { releaseCommand, RELEASE_HELP } from "../../src/commands/release.js";
import { AxiError } from "../../src/errors.js";
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

function releasePayload(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.0",
    name: "v1.2.0",
    description: "notes",
    released_at: "2024-01-01T00:00:00Z",
    author: { username: "alice" },
    ...overrides,
  };
}

describe("releaseCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await releaseCommand(["--help"])).toBe(RELEASE_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await releaseCommand([])).toBe(RELEASE_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await releaseCommand(["unknown"]);
      expect(result).toContain("Unknown subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(
        releaseCommand(["create", "v1", "--draft"], ctx),
      ).rejects.toThrow(/unknown flag for glab-axi release create: --draft/);
      expect(mockedApi).not.toHaveBeenCalled();
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reads projects/:id/releases with the clamped per_page limit", async () => {
      mockedApi.mockResolvedValueOnce([releasePayload()]);

      const result = await releaseCommand(["list"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/releases?per_page=30"]);
      expect(result).toContain("v1.2.0");
    });
  });

  describe("view", () => {
    it("requires a tag", async () => {
      await expect(releaseCommand(["view"], ctx)).rejects.toThrow(
        "Tag is required",
      );
    });

    it("fetches the release by tag and truncates the body by default", async () => {
      mockedApi.mockResolvedValueOnce(
        releasePayload({ description: "x".repeat(2000) }),
      );

      const result = await releaseCommand(["view", "v1.2.0"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/releases/v1.2.0"]);
      expect(result).toContain("truncated");
    });

    it("shows the full body with --full", async () => {
      mockedApi.mockResolvedValueOnce(
        releasePayload({ description: "x".repeat(2000) }),
      );

      const result = await releaseCommand(["view", "v1.2.0", "--full"], ctx);

      expect(result).not.toContain("truncated");
    });
  });

  describe("create", () => {
    it("requires a tag", async () => {
      await expect(releaseCommand(["create"], ctx)).rejects.toThrow(
        "Tag is required",
      );
    });

    it("maps --title/--body/--target to glab release create flags, with files appended", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await releaseCommand(
        [
          "create",
          "v1.3.0",
          "--title",
          "v1.3.0",
          "--body",
          "notes",
          "--target",
          "main",
          "dist/app.zip",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "release",
        "create",
        "v1.3.0",
        "--notes",
        "notes",
        "--name",
        "v1.3.0",
        "--ref",
        "main",
        "dist/app.zip",
      ]);
      expect(result).toContain("created: ok");
    });
  });

  describe("edit", () => {
    it("delegates to the same glab release create upsert flow", async () => {
      mockedExec.mockResolvedValueOnce("");

      const result = await releaseCommand(
        ["edit", "v1.3.0", "--title", "v1.3.0 — fixes"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "release",
        "create",
        "v1.3.0",
        "--name",
        "v1.3.0 — fixes",
      ]);
      expect(result).toContain("edit: ok");
    });
  });

  describe("delete", () => {
    it("reports already_deleted when the release is gone", async () => {
      mockedApi.mockRejectedValueOnce(new AxiError("gone", "NOT_FOUND"));

      const result = await releaseCommand(["delete", "v1.3.0"], ctx);

      expect(result).toContain("already_deleted");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("deletes with --yes and --with-tag when requested", async () => {
      mockedApi.mockResolvedValueOnce(releasePayload());
      mockedExec.mockResolvedValueOnce("");

      await releaseCommand(["delete", "v1.3.0", "--with-tag"], ctx);

      expect(execArgsOf()).toEqual([
        "release",
        "delete",
        "v1.3.0",
        "--yes",
        "--with-tag",
      ]);
    });
  });

  describe("download", () => {
    it("maps --pattern to --asset-name", async () => {
      mockedExec.mockResolvedValueOnce("");

      await releaseCommand(
        ["download", "v1.3.0", "--pattern", "*.zip", "--dir", "out"],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "release",
        "download",
        "v1.3.0",
        "--asset-name",
        "*.zip",
        "--dir",
        "out",
      ]);
    });

    it("does not swallow the tag when --dir comes before it", async () => {
      mockedExec.mockResolvedValueOnce("");

      await releaseCommand(["download", "--dir", "out", "v1.3.0"], ctx);

      expect(execArgsOf()).toEqual([
        "release",
        "download",
        "v1.3.0",
        "--dir",
        "out",
      ]);
    });
  });

  describe("upload", () => {
    it("requires a tag and at least one file", async () => {
      await expect(releaseCommand(["upload"], ctx)).rejects.toThrow(
        "Tag is required",
      );
      await expect(releaseCommand(["upload", "v1"], ctx)).rejects.toThrow(
        "At least one file is required",
      );
    });

    it("passes the files through to glab release upload", async () => {
      mockedExec.mockResolvedValueOnce("");

      await releaseCommand(["upload", "v1.3.0", "a.zip", "b.zip"], ctx);

      expect(execArgsOf()).toEqual([
        "release",
        "upload",
        "v1.3.0",
        "a.zip",
        "b.zip",
      ]);
    });
  });
});
