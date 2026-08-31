import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { issueCommand, ISSUE_HELP } from "../../src/commands/issue.js";
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

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    iid: 42,
    title: "Fix login",
    state: "opened",
    author: { username: "alice" },
    description: "steps to reproduce",
    labels: ["bug"],
    assignees: [{ username: "bob" }],
    milestone: { title: "v1.0" },
    created_at: "2026-01-01T00:00:00Z",
    user_notes_count: 2,
    discussion_locked: false,
    web_url: "https://gitlab.test/group/sub/project/-/issues/42",
    ...overrides,
  };
}

async function withBodyFile<T>(
  body: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "glab-axi-issue-body-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body, "utf8");
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("issueCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await issueCommand(["--help"])).toBe(ISSUE_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await issueCommand([])).toBe(ISSUE_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await issueCommand(["unknown"]);
      expect(result).toContain("Unknown issue subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(
        issueCommand(["list", "--to-repo", "x"], ctx),
      ).rejects.toThrow(/unknown flag for glab-axi issue list: --to-repo/);
      expect(mockedApi).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reads the project issues endpoint with default filters", async () => {
      mockedApi.mockResolvedValue([issuePayload()]);

      const result = await issueCommand(["list"], ctx);

      const path = apiPathsOf()[0];
      expect(path.startsWith("projects/:id/issues?")).toBe(true);
      const query = new URLSearchParams(path.split("?")[1]);
      expect(query.get("state")).toBe("opened");
      expect(query.get("per_page")).toBe("30");
      expect(mockedApi.mock.calls[0][1]).toEqual({ ctx });
      expect(result).toContain("count: 1");
      expect(result).toContain("issues[1]");
      expect(result).toContain("42");
      expect(result).toContain("issue view <iid>");
    });

    it("maps every filter onto its GitLab query parameter", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(
        [
          "list",
          "--state",
          "closed",
          "--label",
          "bug",
          "--label",
          "ui",
          "--assignee",
          "alice",
          "--author",
          "bob",
          "--milestone",
          "v1.0",
          "--search",
          "login",
          "--limit",
          "5",
        ],
        ctx,
      );

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("state")).toBe("closed");
      expect(query.get("labels")).toBe("bug,ui");
      expect(query.get("assignee_username")).toBe("alice");
      expect(query.get("author_username")).toBe("bob");
      expect(query.get("milestone")).toBe("v1.0");
      expect(query.get("search")).toBe("login");
      expect(query.get("per_page")).toBe("5");
    });

    it("caps --limit at the GitLab per_page maximum of 100", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(["list", "--limit", "500"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("per_page")).toBe("100");
    });

    it("maps --sort created onto order_by=created_at&sort=desc", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(["list", "--sort", "created"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("order_by")).toBe("created_at");
      expect(query.get("sort")).toBe("desc");
    });

    it("maps --sort updated onto order_by=updated_at&sort=desc", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(["list", "--sort", "updated"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("order_by")).toBe("updated_at");
      expect(query.get("sort")).toBe("desc");
    });

    it("rejects --sort comments with an explanation instead of silently dropping it", async () => {
      await expect(
        issueCommand(["list", "--sort", "comments"], ctx),
      ).rejects.toThrow(/--sort comments has no GitLab equivalent/);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("rejects an unknown --sort value", async () => {
      await expect(
        issueCommand(["list", "--sort", "bogus"], ctx),
      ).rejects.toThrow(AxiError);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("omits order_by/sort when --sort is not passed", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(["list"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("order_by")).toBeNull();
      expect(query.get("sort")).toBeNull();
    });

    it("adds updatedAt and closedAt columns with --fields", async () => {
      mockedApi.mockResolvedValue([
        issuePayload({
          updated_at: "2026-01-05T00:00:00Z",
          closed_at: "2026-01-06T00:00:00Z",
        }),
      ]);

      const result = await issueCommand(
        ["list", "--fields", "updatedAt,closedAt"],
        ctx,
      );

      expect(result).toContain("updatedAt");
      expect(result).toContain("closedAt");
    });

    it("suggests creating an issue when the list is empty", async () => {
      mockedApi.mockResolvedValue([]);

      const result = await issueCommand(["list"], ctx);

      expect(result).toContain("count: 0");
      expect(result).toContain("issue create");
      expect(result).toContain("-R group/sub/project");
    });

    it("adds requested extra columns with --fields", async () => {
      mockedApi.mockResolvedValue([
        issuePayload({
          labels: ["bug"],
          web_url: "https://gitlab.test/group/sub/project/-/issues/42",
        }),
      ]);

      const result = await issueCommand(
        ["list", "--fields", "labels,url,milestone"],
        ctx,
      );

      expect(result).toContain("bug");
      expect(result).toContain(
        "https://gitlab.test/group/sub/project/-/issues/42",
      );
      expect(result).toContain("v1.0");
    });

    it("throws VALIDATION_ERROR for unknown --fields", async () => {
      await expect(
        issueCommand(["list", "--fields", "nope"], ctx),
      ).rejects.toThrow(AxiError);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("rejects an empty --label value instead of dropping it", async () => {
      await expect(issueCommand(["list", "--label="], ctx)).rejects.toThrow(
        /--label requires a value/,
      );
    });

    it("passes all repeated --label filters to the query", async () => {
      mockedApi.mockResolvedValue([]);

      await issueCommand(["list", "--label", "bug", "--label", "chore"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("labels")).toBe("bug,chore");
    });
  });

  describe("view", () => {
    it("renders the iid, labels, assignees and milestone", async () => {
      mockedApi.mockResolvedValue(issuePayload());

      const result = await issueCommand(["view", "42"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/issues/42"]);
      expect(result).toContain("issue");
      expect(result).toContain("iid: 42");
      expect(result).toContain("labels: bug");
      expect(result).toContain("assignees: bob");
      expect(result).toContain("milestone: v1.0");
      expect(result).toContain("2 — use --comments to see full comments");
    });

    it("omits help suggestions from detail view", async () => {
      mockedApi.mockResolvedValue(issuePayload());
      const result = await issueCommand(["view", "42"], ctx);
      expect(result).not.toMatch(/^help\[/m);
    });

    it("lists user comments and drops system notes with --comments", async () => {
      mockedApi.mockResolvedValueOnce(issuePayload()).mockResolvedValueOnce([
        { body: "changed the description", system: true },
        {
          body: "looks good",
          system: false,
          author: { username: "bob" },
          created_at: "2026-01-02T00:00:00Z",
        },
      ]);

      const result = await issueCommand(["view", "42", "--comments"], ctx);

      expect(apiPathsOf()[1]).toBe("projects/:id/issues/42/notes?per_page=100");
      expect(result).toContain("looks good");
      expect(result).not.toContain("changed the description");
    });

    it("truncates the description unless --full is passed", async () => {
      const long = "x".repeat(900);
      mockedApi.mockResolvedValue(issuePayload({ description: long }));

      const truncated = await issueCommand(["view", "42"], ctx);
      expect(truncated).toContain("truncated");

      mockedApi.mockResolvedValue(issuePayload({ description: long }));
      const full = await issueCommand(["view", "42", "--full"], ctx);
      expect(full).not.toContain("truncated");
    });
  });

  describe("create", () => {
    it("requires --title", async () => {
      await expect(issueCommand(["create"], ctx)).rejects.toThrow(
        "--title is required",
      );
    });

    it("passes every repeatable flag once per value and forces non-interactive mode", async () => {
      mockedExec.mockResolvedValue(
        "https://gitlab.test/group/sub/project/-/issues/42\n",
      );

      const result = await issueCommand(
        [
          "create",
          "--title",
          "Fix login",
          "--body",
          "steps",
          "--assignee",
          "alice",
          "--assignee",
          "bob",
          "--label",
          "bug",
          "--label",
          "urgent",
          "--milestone",
          "v1.0",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "issue",
        "create",
        "--title",
        "Fix login",
        "--description",
        "steps",
        "--yes",
        "--assignee",
        "alice",
        "--assignee",
        "bob",
        "--label",
        "bug",
        "--label",
        "urgent",
        "--milestone",
        "v1.0",
      ]);
      expect(result).toContain("iid: 42");
      expect(result).toContain("issue view 42");
    });

    it("sends an empty description when no body is given", async () => {
      mockedExec.mockResolvedValue(
        "https://gitlab.test/group/sub/project/-/issues/7\n",
      );

      await issueCommand(["create", "--title", "T"], ctx);

      expect(execArgsOf()).toEqual([
        "issue",
        "create",
        "--title",
        "T",
        "--description",
        "",
        "--yes",
      ]);
    });
  });

  describe("edit", () => {
    it("maps add/remove flags onto glab issue update prefixes", async () => {
      mockedExec.mockResolvedValue("");
      mockedApi.mockResolvedValue(issuePayload({ title: "New" }));

      await issueCommand(
        [
          "edit",
          "42",
          "--title",
          "New",
          "--add-label",
          "bug",
          "--remove-label",
          "wip",
          "--add-assignee",
          "carol",
          "--remove-assignee",
          "dave",
          "--milestone",
          "v2.0",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "issue",
        "update",
        "42",
        "--title",
        "New",
        "--label",
        "bug",
        "--unlabel",
        "wip",
        "--assignee",
        "+carol",
        "--assignee",
        "!dave",
        "--milestone",
        "v2.0",
      ]);
    });

    it("skips glab issue update entirely when nothing changed", async () => {
      mockedApi.mockResolvedValue(issuePayload());

      await issueCommand(["edit", "42"], ctx);

      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("renders the updated issue", async () => {
      mockedExec.mockResolvedValue("");
      mockedApi.mockResolvedValue(
        issuePayload({
          labels: ["bug", "ui"],
          assignees: [{ username: "carol" }],
        }),
      );

      const result = await issueCommand(
        ["edit", "42", "--add-label", "ui"],
        ctx,
      );

      expect(result).toContain('labels: "bug,ui"');
      expect(result).toContain("assignees: carol");
    });
  });

  describe("--body-file", () => {
    const markdownBody = "steps\n```sh\necho ok\n```\nIt's reproducible.";

    it("uses file contents for issue create", async () => {
      await withBodyFile(markdownBody, async (file) => {
        mockedExec.mockResolvedValue(
          "https://gitlab.test/group/sub/project/-/issues/42\n",
        );

        await issueCommand(
          ["create", "--title", "Fix login", "--body-file", file],
          ctx,
        );

        expect(execArgsOf()).toEqual([
          "issue",
          "create",
          "--title",
          "Fix login",
          "--description",
          markdownBody,
          "--yes",
        ]);
      });
    });

    it("uses file contents for issue edit", async () => {
      await withBodyFile(markdownBody, async (file) => {
        mockedExec.mockResolvedValue("");
        mockedApi.mockResolvedValue(issuePayload());

        await issueCommand(["edit", "42", "--body-file", file], ctx);

        expect(execArgsOf()).toEqual([
          "issue",
          "update",
          "42",
          "--description",
          markdownBody,
        ]);
      });
    });

    it("uses file contents for issue comment", async () => {
      await withBodyFile(markdownBody, async (file) => {
        mockedApi.mockResolvedValue({
          author: { username: "alice" },
          body: markdownBody,
          created_at: "2026-01-01T00:00:00Z",
        });

        await issueCommand(["comment", "42", "--body-file", file], ctx);

        expect(apiPathsOf()).toEqual(["projects/:id/issues/42/notes"]);
        expect(mockedApi.mock.calls[0][1]).toEqual({
          ctx,
          method: "POST",
          fields: { body: markdownBody },
        });
      });
    });
  });

  describe("close", () => {
    it("closes an open issue", async () => {
      mockedApi.mockResolvedValueOnce(issuePayload());
      mockedExec.mockResolvedValue("");

      const result = await issueCommand(["close", "42"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(["issue", "close", "42"], ctx);
      expect(result).toContain("status: ok");
    });

    it("returns already closed when the issue is already closed (idempotent)", async () => {
      mockedApi.mockResolvedValueOnce(issuePayload({ state: "closed" }));

      const result = await issueCommand(["close", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("reopen", () => {
    it("reopens a closed issue", async () => {
      mockedApi.mockResolvedValueOnce(issuePayload({ state: "closed" }));
      mockedExec.mockResolvedValue("");

      const result = await issueCommand(["reopen", "42"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(["issue", "reopen", "42"], ctx);
      expect(result).toContain("status: ok");
    });

    it("returns already open when the issue is already open (idempotent)", async () => {
      mockedApi.mockResolvedValueOnce(issuePayload({ state: "opened" }));

      const result = await issueCommand(["reopen", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("comment", () => {
    it("requires a body", async () => {
      await expect(issueCommand(["comment", "42"], ctx)).rejects.toThrow(
        AxiError,
      );
    });

    it("posts a note through the API and renders it", async () => {
      mockedApi.mockResolvedValue({
        author: { username: "alice" },
        body: "on it",
        created_at: "2026-01-01T00:00:00Z",
      });

      const result = await issueCommand(
        ["comment", "42", "--body", "on it"],
        ctx,
      );

      expect(apiPathsOf()).toEqual(["projects/:id/issues/42/notes"]);
      expect(mockedApi.mock.calls[0][1]).toEqual({
        ctx,
        method: "POST",
        fields: { body: "on it" },
      });
      expect(result).toContain("on it");
      expect(result).toContain("alice");
    });
  });

  describe("delete", () => {
    it("deletes the issue", async () => {
      mockedExec.mockResolvedValue("");

      const result = await issueCommand(["delete", "42"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(["issue", "delete", "42"], ctx);
      expect(result).toContain("status: ok");
    });
  });

  describe("lock", () => {
    it("locks discussion on an unlocked issue", async () => {
      mockedApi
        .mockResolvedValueOnce(issuePayload({ discussion_locked: false }))
        .mockResolvedValueOnce(issuePayload({ discussion_locked: true }));
      mockedExec.mockResolvedValue("");

      const result = await issueCommand(["lock", "42"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(
        ["issue", "update", "42", "--lock-discussion"],
        ctx,
      );
      expect(result).toContain("locked: yes");
    });

    it("returns already locked when the discussion is already locked (idempotent)", async () => {
      mockedApi.mockResolvedValueOnce(
        issuePayload({ discussion_locked: true }),
      );

      const result = await issueCommand(["lock", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("unlock", () => {
    it("unlocks discussion on a locked issue", async () => {
      mockedApi
        .mockResolvedValueOnce(issuePayload({ discussion_locked: true }))
        .mockResolvedValueOnce(issuePayload({ discussion_locked: false }));
      mockedExec.mockResolvedValue("");

      const result = await issueCommand(["unlock", "42"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(
        ["issue", "update", "42", "--unlock-discussion"],
        ctx,
      );
      expect(result).toContain("locked: no");
    });

    it("returns already unlocked when the discussion is already unlocked (idempotent)", async () => {
      mockedApi.mockResolvedValueOnce(
        issuePayload({ discussion_locked: false }),
      );

      const result = await issueCommand(["unlock", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });
});
