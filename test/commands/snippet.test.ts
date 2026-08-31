import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabApiJsonBody: vi.fn(),
  glabApiText: vi.fn(),
}));
vi.mock("../../src/stdin.js", () => ({
  isStdinTTY: vi.fn(() => false),
  readStdin: vi.fn(async () => ""),
}));

import { glabApiJson, glabApiJsonBody, glabApiText } from "../../src/glab.js";
import { isStdinTTY, readStdin } from "../../src/stdin.js";
import { snippetCommand, SNIPPET_HELP } from "../../src/commands/snippet.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

const mockedApiJson = vi.mocked(glabApiJson);
const mockedApiJsonBody = vi.mocked(glabApiJsonBody);
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
      mockedApiJsonBody.mockResolvedValue({
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

      expect(mockedApiJsonBody).toHaveBeenCalledWith(
        "projects/:id/snippets",
        {
          title: "x",
          visibility: "private",
          files: [{ file_path: "hello.txt", content: "content" }],
        },
        { ctx, method: "POST" },
      );
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

    describe("multiple --file inputs", () => {
      let dir: string;
      let pathA: string;
      let pathB: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "glab-axi-snippet-create-"));
        pathA = join(dir, "a.py");
        pathB = join(dir, "b.py");
        writeFileSync(pathA, "content a", "utf8");
        writeFileSync(pathB, "content b", "utf8");
      });

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      it("attaches every --file, not just the first", async () => {
        mockedApiJsonBody.mockResolvedValue({
          id: 6,
          title: "x",
          description: null,
          visibility: "private",
          updated_at: "2024-01-01T00:00:00Z",
          web_url: "https://x",
        });

        await snippetCommand(
          ["create", "--title", "x", "--file", pathA, "--file", pathB],
          ctx,
        );

        expect(mockedApiJsonBody).toHaveBeenCalledWith(
          "projects/:id/snippets",
          {
            title: "x",
            visibility: "private",
            files: [
              { file_path: "a.py", content: "content a" },
              { file_path: "b.py", content: "content b" },
            ],
          },
          { ctx, method: "POST" },
        );
      });

      it("attaches every positional path, not just the first", async () => {
        mockedApiJsonBody.mockResolvedValue({
          id: 7,
          title: "x",
          description: null,
          visibility: "private",
          updated_at: "2024-01-01T00:00:00Z",
          web_url: "https://x",
        });

        await snippetCommand(["create", "--title", "x", pathA, pathB], ctx);

        expect(mockedApiJsonBody).toHaveBeenCalledWith(
          "projects/:id/snippets",
          {
            title: "x",
            visibility: "private",
            files: [
              { file_path: "a.py", content: "content a" },
              { file_path: "b.py", content: "content b" },
            ],
          },
          { ctx, method: "POST" },
        );
      });

      it("rejects mixing positional paths with --file", async () => {
        await expect(
          snippetCommand(
            ["create", "--title", "x", pathA, "--file", pathB],
            ctx,
          ),
        ).rejects.toBeInstanceOf(AxiError);
        expect(mockedApiJsonBody).not.toHaveBeenCalled();
      });
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
      mockedApiJsonBody.mockResolvedValue({});

      const output = await snippetCommand(
        ["edit", "42", "--title", "New title"],
        ctx,
      );

      expect(mockedApiJsonBody).toHaveBeenCalledWith(
        "projects/:id/snippets/42",
        { title: "New title" },
        { ctx, method: "PUT" },
      );
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
      mockedApiJsonBody.mockResolvedValue({});

      await snippetCommand(["edit", "42", "--remove", "old.txt"], ctx);

      expect(mockedApiJsonBody).toHaveBeenCalledWith(
        "projects/:id/snippets/42",
        { files: [{ file_path: "old.txt", action: "delete" }] },
        { ctx, method: "PUT" },
      );
    });

    it("adds a file from piped stdin", async () => {
      mockedReadStdin.mockResolvedValue("new content");
      mockedApiJsonBody.mockResolvedValue({});

      await snippetCommand(["edit", "42", "--add", "notes.md", "-"], ctx);

      expect(mockedApiJsonBody).toHaveBeenCalledWith(
        "projects/:id/snippets/42",
        {
          files: [
            { file_path: "notes.md", content: "new content", action: "create" },
          ],
        },
        { ctx, method: "PUT" },
      );
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

    it("rejects an unknown flag before calling glab", async () => {
      await expect(
        snippetCommand(["delete", "42", "--presonal"], ctx),
      ).rejects.toThrow(/unknown flag for glab-axi snippet delete: --presonal/);
      expect(mockedApiText).not.toHaveBeenCalled();
    });
  });

  it("rejects an unknown subcommand", async () => {
    const output = await snippetCommand(["bogus"], ctx);
    expect(output).toContain("Unknown subcommand: bogus");
  });
});
