import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabApiText: vi.fn(),
}));
vi.mock("../../src/stdin.js", () => ({
  isStdinTTY: vi.fn(() => false),
  readStdin: vi.fn(async () => ""),
}));

import { glabApiJson, glabApiText } from "../../src/glab.js";
import { isStdinTTY, readStdin } from "../../src/stdin.js";
import { snippetCommand, SNIPPET_HELP } from "../../src/commands/snippet.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

const mockedApiJson = vi.mocked(glabApiJson);
const mockedApiText = vi.mocked(glabApiText);
const mockedReadStdin = vi.mocked(readStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);

const ctx: RepoContext = { fullPath: "group/project", source: "flag" };

describe("snippetCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("");
  });

  it("returns help without invoking glab", async () => {
    expect(await snippetCommand([], ctx)).toBe(SNIPPET_HELP);
    expect(mockedApiJson).not.toHaveBeenCalled();
  });

  describe("list", () => {
    it("lists project snippets by default", async () => {
      mockedApiJson.mockResolvedValue([
        {
          id: 1,
          title: "notes",
          description: null,
          visibility: "private",
          updated_at: "2024-01-01T00:00:00Z",
          web_url: "https://gitlab.com/group/project/-/snippets/1",
        },
      ]);

      const output = await snippetCommand(["list"], ctx);

      expect(mockedApiJson).toHaveBeenCalledWith(
        "projects/:id/snippets?per_page=100",
        { ctx },
      );
      expect(output).toContain("notes");
    });

    it("lists personal snippets without a project context", async () => {
      mockedApiJson.mockResolvedValue([]);

      await snippetCommand(["list", "--personal"], ctx);

      expect(mockedApiJson).toHaveBeenCalledWith("/snippets?per_page=100", {
        ctx: undefined,
      });
    });

    it("requires a project context unless --personal is given", async () => {
      await expect(snippetCommand(["list"], undefined)).rejects.toBeInstanceOf(
        AxiError,
      );
      expect(mockedApiJson).not.toHaveBeenCalled();
    });
  });

  describe("view", () => {
    it("requires a selector", async () => {
      await expect(snippetCommand(["view"], ctx)).rejects.toBeInstanceOf(
        AxiError,
      );
    });

    it("fetches metadata and raw content", async () => {
      mockedApiJson.mockResolvedValue({
        id: 42,
        title: "notes",
        description: "desc",
        visibility: "private",
        updated_at: "2024-01-01T00:00:00Z",
        web_url: "https://gitlab.com/group/project/-/snippets/42",
        files: [{ path: "notes.txt", raw_url: "https://x/raw" }],
      });
      mockedApiText.mockResolvedValue("hello world");

      const output = await snippetCommand(["view", "42"], ctx);

      expect(mockedApiJson).toHaveBeenCalledWith("projects/:id/snippets/42", {
        ctx,
      });
      expect(mockedApiText).toHaveBeenCalledWith(
        "projects/:id/snippets/42/raw",
        { ctx },
      );
      expect(output).toContain("hello world");
      expect(output).toContain("notes.txt");
    });

    it("shows file names only with --files", async () => {
      mockedApiJson.mockResolvedValue({
        id: 42,
        title: "notes",
        description: null,
        visibility: "private",
        updated_at: "2024-01-01T00:00:00Z",
        web_url: "https://x",
        files: [{ path: "a.txt", raw_url: "https://x/raw" }],
      });

      const output = await snippetCommand(["view", "42", "--files"], ctx);

      expect(mockedApiText).not.toHaveBeenCalled();
      expect(output).toContain("a.txt");
    });

    it("routes personal snippets to the user-scoped endpoint", async () => {
      mockedApiJson.mockResolvedValue({
        id: 7,
        title: "p",
        description: null,
        visibility: "private",
        updated_at: "2024-01-01T00:00:00Z",
        web_url: "https://x",
        files: [],
      });
      mockedApiText.mockResolvedValue("");

      await snippetCommand(["view", "7", "--personal"], ctx);

      expect(mockedApiJson).toHaveBeenCalledWith("/snippets/7", {
        ctx: undefined,
      });
    });
  });

  describe("create", () => {
    it("requires --title", async () => {
      await expect(
        snippetCommand(["create", "--file", "a.py"], ctx),
      ).rejects.toBeInstanceOf(AxiError);
    });

    it("requires content from stdin, positional, or --file", async () => {
      await expect(
        snippetCommand(["create", "--title", "x"], ctx),
      ).rejects.toBeInstanceOf(AxiError);
    });

    it("rejects an invalid --visibility", async () => {
      await expect(
        snippetCommand(
          [
            "create",
            "--title",
            "x",
            "--visibility",
            "bogus",
            "--filename",
            "a",
          ],
          ctx,
        ),
      ).rejects.toBeInstanceOf(AxiError);
    });

    it("creates a snippet from piped content via --filename", async () => {
      mockedReadStdin.mockResolvedValue("content");
      mockedApiJson.mockResolvedValue({
        id: 5,
        title: "x",
        description: null,
        visibility: "private",
        updated_at: "2024-01-01T00:00:00Z",
        web_url: "https://gitlab.com/group/project/-/snippets/5",
      });

      const output = await snippetCommand(
        ["create", "--title", "x", "--filename", "hello.txt"],
        ctx,
      );

      expect(mockedApiJson).toHaveBeenCalledWith("projects/:id/snippets", {
        ctx,
        method: "POST",
        fields: {
          title: "x",
          visibility: "private",
          "files[0][file_path]": "hello.txt",
          "files[0][content]": "content",
        },
      });
      expect(output).toContain("id: 5");
    });

    it("rejects piped content on a TTY", async () => {
      mockedIsStdinTTY.mockReturnValue(true);
      await expect(
        snippetCommand(
          ["create", "--title", "x", "--filename", "hello.txt"],
          ctx,
        ),
      ).rejects.toBeInstanceOf(AxiError);
    });
  });

  describe("edit", () => {
    it("requires a selector", async () => {
      await expect(
        snippetCommand(["edit", "--title", "x"], ctx),
      ).rejects.toBeInstanceOf(AxiError);
    });

    it("requires at least one edit flag", async () => {
      await expect(snippetCommand(["edit", "42"], ctx)).rejects.toBeInstanceOf(
        AxiError,
      );
    });

    it("updates metadata", async () => {
      mockedApiJson.mockResolvedValue({});

      const output = await snippetCommand(
        ["edit", "42", "--title", "New title"],
        ctx,
      );

      expect(mockedApiJson).toHaveBeenCalledWith("projects/:id/snippets/42", {
        ctx,
        method: "PUT",
        fields: { title: "New title" },
      });
      expect(output).toContain("edited: ok");
    });

    it("rejects mixing --add and --remove", async () => {
      await expect(
        snippetCommand(
          ["edit", "42", "--add", "a.txt", "--remove", "b.txt"],
          ctx,
        ),
      ).rejects.toBeInstanceOf(AxiError);
    });

    it("removes a file", async () => {
      mockedApiJson.mockResolvedValue({});

      await snippetCommand(["edit", "42", "--remove", "old.txt"], ctx);

      expect(mockedApiJson).toHaveBeenCalledWith("projects/:id/snippets/42", {
        ctx,
        method: "PUT",
        fields: {
          "files[0][file_path]": "old.txt",
          "files[0][action]": "delete",
        },
      });
    });
  });

  describe("delete", () => {
    it("requires a selector", async () => {
      await expect(snippetCommand(["delete"], ctx)).rejects.toBeInstanceOf(
        AxiError,
      );
    });

    it("deletes a project snippet", async () => {
      mockedApiText.mockResolvedValue("");

      const output = await snippetCommand(["delete", "42"], ctx);

      expect(mockedApiText).toHaveBeenCalledWith("projects/:id/snippets/42", {
        ctx,
        method: "DELETE",
      });
      expect(output).toContain('deleted: "42"');
    });

    it("deletes a personal snippet without forwarding ctx", async () => {
      mockedApiText.mockResolvedValue("");

      await snippetCommand(["delete", "42", "--personal"], ctx);

      expect(mockedApiText).toHaveBeenCalledWith("/snippets/42", {
        ctx: undefined,
        method: "DELETE",
      });
    });
  });

  it("rejects an unknown subcommand", async () => {
    const output = await snippetCommand(["bogus"], ctx);
    expect(output).toContain("Unknown subcommand: bogus");
  });
});
