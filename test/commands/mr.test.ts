import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { mrCommand, MR_HELP } from "../../src/commands/mr.js";
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

function mrPayload(overrides: Record<string, unknown> = {}) {
  return {
    iid: 42,
    title: "Add widget",
    state: "opened",
    author: { username: "alice" },
    draft: false,
    detailed_merge_status: "mergeable",
    source_branch: "feat/widget",
    target_branch: "main",
    merged_at: null,
    description: "why",
    user_notes_count: 3,
    reviewers: [{ username: "bob" }],
    head_pipeline: { id: 777, status: "success" },
    ...overrides,
  };
}

async function withBodyFile<T>(
  body: string,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "glab-axi-mr-body-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body, "utf8");
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("mrCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await mrCommand(["--help"])).toBe(MR_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await mrCommand([])).toBe(MR_HELP);
    });

    it("returns error for unknown subcommand", async () => {
      const result = await mrCommand(["unknown"]);
      expect(result).toContain("Unknown mr subcommand: unknown");
    });

    it("rejects an unknown flag before calling glab", async () => {
      await expect(mrCommand(["list", "--base", "main"], ctx)).rejects.toThrow(
        /unknown flag for glab-axi mr list: --base/,
      );
      expect(mockedApi).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("reads the project merge requests endpoint with default filters", async () => {
      mockedApi.mockResolvedValue([mrPayload()]);

      const result = await mrCommand(["list"], ctx);

      const path = apiPathsOf()[0];
      expect(path.startsWith("projects/:id/merge_requests?")).toBe(true);
      const query = new URLSearchParams(path.split("?")[1]);
      expect(query.get("state")).toBe("opened");
      expect(query.get("per_page")).toBe("30");
      expect(mockedApi.mock.calls[0][1]).toEqual({ ctx });
      expect(result).toContain("count: 1");
      expect(result).toContain("merge_requests");
      expect(result).toContain("42");
      expect(result).toContain("mergeable");
      expect(result).toContain("mr view <iid>");
    });

    it("maps every filter onto its GitLab query parameter", async () => {
      mockedApi.mockResolvedValue([]);

      await mrCommand(
        [
          "list",
          "--state",
          "merged",
          "--label",
          "bug",
          "--label",
          "ui",
          "--assignee",
          "alice",
          "--author",
          "bob",
          "--target-branch",
          "main",
          "--source-branch",
          "feat/x",
          "--draft",
          "--search",
          "widget",
          "--limit",
          "5",
        ],
        ctx,
      );

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("state")).toBe("merged");
      expect(query.get("labels")).toBe("bug,ui");
      expect(query.get("assignee_username")).toBe("alice");
      expect(query.get("author_username")).toBe("bob");
      expect(query.get("target_branch")).toBe("main");
      expect(query.get("source_branch")).toBe("feat/x");
      expect(query.get("draft")).toBe("true");
      expect(query.get("search")).toBe("widget");
      expect(query.get("per_page")).toBe("5");
    });

    it("clamps --limit to GitLab's 100-per-page cap", async () => {
      mockedApi.mockResolvedValue([]);

      await mrCommand(["list", "--limit", "500"], ctx);

      const query = new URLSearchParams(apiPathsOf()[0].split("?")[1]);
      expect(query.get("per_page")).toBe("100");
    });

    it("rejects a non-numeric --limit", async () => {
      await expect(mrCommand(["list", "--limit", "abc"], ctx)).rejects.toThrow(
        /--limit must be a positive integer/,
      );
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("suggests creating a merge request when the list is empty", async () => {
      mockedApi.mockResolvedValue([]);

      const result = await mrCommand(["list"], ctx);

      expect(result).toContain("count: 0");
      expect(result).toContain("mr create");
      expect(result).toContain("-R group/sub/project");
    });

    it("adds requested extra columns with --fields", async () => {
      mockedApi.mockResolvedValue([
        mrPayload({ labels: ["bug"], web_url: "https://example.test/mr/42" }),
      ]);

      const result = await mrCommand(
        ["list", "--fields", "labels,url,target_branch"],
        ctx,
      );

      expect(result).toContain("bug");
      expect(result).toContain("https://example.test/mr/42");
      expect(result).toContain("main");
    });

    it("throws VALIDATION_ERROR for unknown --fields", async () => {
      await expect(
        mrCommand(["list", "--fields", "nope"], ctx),
      ).rejects.toThrow(AxiError);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("rejects an empty --label value instead of dropping it", async () => {
      await expect(mrCommand(["list", "--label="], ctx)).rejects.toThrow(
        /--label requires a value/,
      );
    });
  });

  describe("view", () => {
    it("renders the iid, branches, merge status and pipeline", async () => {
      mockedApi.mockResolvedValue(mrPayload());

      const result = await mrCommand(["view", "42"], ctx);

      expect(apiPathsOf()).toEqual(["projects/:id/merge_requests/42"]);
      expect(result).toContain("merge_request");
      expect(result).toContain("iid: 42");
      expect(result).toContain("source_branch: feat/widget");
      expect(result).toContain("target_branch: main");
      expect(result).toContain("merge_status: mergeable");
      expect(result).toContain("pipeline: success — pipeline 777");
      expect(result).toContain("reviewers: bob");
      expect(result).toContain("3 — use --comments to see full comments");
      expect(result).toContain("use --reviews to see approvals");
    });

    it("reports a missing head pipeline instead of inventing one", async () => {
      mockedApi.mockResolvedValue(mrPayload({ head_pipeline: null }));

      const result = await mrCommand(["view", "42"], ctx);

      expect(result).toContain("no pipeline for the head commit");
    });

    it("lists user comments and drops system notes with --comments", async () => {
      mockedApi.mockResolvedValueOnce(mrPayload()).mockResolvedValueOnce([
        { body: "changed the description", system: true },
        {
          body: "looks good",
          system: false,
          author: { username: "bob" },
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await mrCommand(["view", "42", "--comments"], ctx);

      expect(apiPathsOf()[1]).toBe(
        "projects/:id/merge_requests/42/notes?per_page=100",
      );
      expect(result).toContain("looks good");
      expect(result).not.toContain("changed the description");
    });

    it("renders approvals and diff review threads with --reviews", async () => {
      mockedApi
        .mockResolvedValueOnce(mrPayload())
        .mockResolvedValueOnce({
          approved: true,
          approvals_required: 2,
          approvals_left: 1,
          approved_by: [{ user: { username: "carol" } }],
        })
        .mockResolvedValueOnce([
          {
            id: "d1",
            notes: [{ body: "plain thread", author: { username: "bob" } }],
          },
          {
            id: "d2",
            notes: [
              {
                body: "rename this",
                author: { username: "carol" },
                resolved: false,
                position: { new_path: "src/a.ts", new_line: 12 },
              },
            ],
          },
        ]);

      const result = await mrCommand(["view", "42", "--reviews"], ctx);

      expect(apiPathsOf()[1]).toBe("projects/:id/merge_requests/42/approvals");
      expect(apiPathsOf()[2]).toBe(
        "projects/:id/merge_requests/42/discussions?per_page=100",
      );
      expect(result).toContain("carol");
      expect(result).toContain("rename this");
      expect(result).toContain("src/a.ts");
      expect(result).not.toContain("plain thread");
    });

    it("keeps optional approval counts null on instances without them", async () => {
      mockedApi
        .mockResolvedValueOnce(mrPayload())
        .mockResolvedValueOnce({ approved: false, approved_by: [] })
        .mockResolvedValueOnce([]);

      const result = await mrCommand(["view", "42", "--reviews"], ctx);

      expect(result).toContain("required: null");
      expect(result).toContain("approved_by: none");
    });

    it("truncates the description unless --full is passed", async () => {
      const long = "x".repeat(900);
      mockedApi.mockResolvedValue(mrPayload({ description: long }));

      const truncated = await mrCommand(["view", "42"], ctx);
      expect(truncated).toContain("truncated");

      mockedApi.mockResolvedValue(mrPayload({ description: long }));
      const full = await mrCommand(["view", "42", "--full"], ctx);
      expect(full).not.toContain("truncated");
    });
  });

  describe("create", () => {
    it("requires --title", async () => {
      await expect(mrCommand(["create"], ctx)).rejects.toThrow(
        "--title is required",
      );
    });

    it("passes every repeatable flag once per value and forces non-interactive mode", async () => {
      mockedExec.mockResolvedValue(
        "https://gitlab.test/group/sub/project/-/merge_requests/42\n",
      );

      const result = await mrCommand(
        [
          "create",
          "--title",
          "Add widget",
          "--body",
          "why",
          "--target-branch",
          "main",
          "--source-branch",
          "feat/widget",
          "--draft",
          "--assignee",
          "alice",
          "--assignee",
          "bob",
          "--reviewer",
          "carol",
          "--label",
          "bug",
          "--label",
          "ui",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "mr",
        "create",
        "--title",
        "Add widget",
        "--description",
        "why",
        "--yes",
        "--target-branch",
        "main",
        "--source-branch",
        "feat/widget",
        "--draft",
        "--assignee",
        "alice",
        "--assignee",
        "bob",
        "--reviewer",
        "carol",
        "--label",
        "bug",
        "--label",
        "ui",
      ]);
      expect(result).toContain("iid: 42");
      expect(result).toContain("mr view 42");
      expect(result).toContain("ci status");
    });

    it("sends an empty description when no body is given", async () => {
      mockedExec.mockResolvedValue(
        "https://gitlab.test/group/sub/project/-/merge_requests/7\n",
      );

      await mrCommand(["create", "--title", "T"], ctx);

      expect(execArgsOf()).toEqual([
        "mr",
        "create",
        "--title",
        "T",
        "--description",
        "",
        "--yes",
      ]);
    });

    it("reports iid: null and drops id-dependent suggestions when the URL regex misses", async () => {
      mockedExec.mockResolvedValue("not a url\n");

      const result = await mrCommand(["create", "--title", "T"], ctx);

      expect(result).toContain("iid: null");
      expect(result).toContain("not a url");
      expect(result).not.toContain("undefined");
      expect(result).not.toContain("mr view");
      expect(result).toContain("ci status");
    });
  });

  describe("edit", () => {
    it("maps add/remove flags onto glab mr update prefixes", async () => {
      mockedExec.mockResolvedValue("");

      await mrCommand(
        [
          "edit",
          "42",
          "--title",
          "New",
          "--add-label",
          "bug",
          "--add-label",
          "ui",
          "--remove-label",
          "wip",
          "--add-assignee",
          "alice",
          "--remove-assignee",
          "bob",
          "--add-reviewer",
          "carol",
          "--remove-reviewer",
          "dan",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "mr",
        "update",
        "42",
        "--yes",
        "--title",
        "New",
        "--label",
        "bug",
        "--label",
        "ui",
        "--unlabel",
        "wip",
        "--assignee",
        "+alice",
        "--assignee",
        "!bob",
        "--reviewer",
        "+carol",
        "--reviewer",
        "!dan",
      ]);
    });
  });

  describe("close and reopen", () => {
    it("reports an already closed merge request without mutating", async () => {
      mockedApi.mockResolvedValue(mrPayload({ state: "closed" }));

      const result = await mrCommand(["close", "42"], ctx);

      expect(result).toContain("already: true");
      expect(result).toContain("state: closed");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("closes an open merge request", async () => {
      mockedApi.mockResolvedValue(mrPayload());
      mockedExec.mockResolvedValue("");

      const result = await mrCommand(["close", "42"], ctx);

      expect(execArgsOf()).toEqual(["mr", "close", "42"]);
      expect(result).toContain("closed");
    });

    it("reports an already open merge request without mutating", async () => {
      mockedApi.mockResolvedValue(mrPayload());

      const result = await mrCommand(["reopen", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("reopens a closed merge request", async () => {
      mockedApi.mockResolvedValue(mrPayload({ state: "closed" }));
      mockedExec.mockResolvedValue("");

      await mrCommand(["reopen", "42"], ctx);

      expect(execArgsOf()).toEqual(["mr", "reopen", "42"]);
    });
  });

  describe("ready", () => {
    it("is a no-op on a merge request that is not a draft", async () => {
      mockedApi.mockResolvedValue(mrPayload());

      const result = await mrCommand(["ready", "42"], ctx);

      expect(result).toContain("already: true");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("marks a draft ready", async () => {
      mockedApi.mockResolvedValue(mrPayload({ draft: true }));
      mockedExec.mockResolvedValue("");

      await mrCommand(["ready", "42"], ctx);

      expect(execArgsOf()).toEqual(["mr", "update", "42", "--ready", "--yes"]);
    });
  });

  describe("merge", () => {
    it("reports an already merged merge request with its merge user", async () => {
      mockedApi.mockResolvedValue(
        mrPayload({
          state: "merged",
          merged_at: "2026-01-01T00:00:00Z",
          merge_user: { username: "carol" },
        }),
      );

      const result = await mrCommand(["merge", "42"], ctx);

      expect(result).toContain("merged_by: carol");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("omits a method flag for the default merge commit", async () => {
      mockedApi.mockResolvedValue(mrPayload());
      mockedExec.mockResolvedValue("");

      const result = await mrCommand(["merge", "42", "--merge"], ctx);

      expect(execArgsOf()).toEqual([
        "mr",
        "merge",
        "42",
        "--yes",
        "--auto-merge=true",
      ]);
      expect(result).toContain("method: merge");
      expect(result).toContain("auto_merge: yes");
    });

    it("spells out --auto-merge=false for --now", async () => {
      mockedApi.mockResolvedValue(mrPayload());
      mockedExec.mockResolvedValue("");

      const result = await mrCommand(["merge", "42", "--now"], ctx);

      expect(execArgsOf()).toEqual([
        "mr",
        "merge",
        "42",
        "--yes",
        "--auto-merge=false",
      ]);
      expect(result).toContain("auto_merge: no");
    });

    it("rejects --auto together with --now", async () => {
      await expect(
        mrCommand(["merge", "42", "--auto", "--now"], ctx),
      ).rejects.toThrow(/either --auto or --now/);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("maps squash, auto and source branch removal onto glab flags", async () => {
      mockedApi.mockResolvedValue(mrPayload());
      mockedExec.mockResolvedValue("");

      await mrCommand(
        [
          "merge",
          "42",
          "--squash",
          "--auto",
          "--remove-source-branch",
          "--body",
          "msg",
        ],
        ctx,
      );

      expect(execArgsOf()).toEqual([
        "mr",
        "merge",
        "42",
        "--yes",
        "--squash",
        "--auto-merge=true",
        "--remove-source-branch",
        "--message",
        "msg",
      ]);
    });

    it("rejects two merge methods at once", async () => {
      await expect(
        mrCommand(["merge", "42", "--squash", "--rebase"], ctx),
      ).rejects.toThrow(/only one merge method/);
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("rejects an unsupported --method", async () => {
      await expect(
        mrCommand(["merge", "42", "--method", "ff"], ctx),
      ).rejects.toThrow(/--method must be one of/);
    });
  });

  describe("review", () => {
    it("approves through glab and posts the body as a note", async () => {
      mockedExec.mockResolvedValue("");
      mockedApi.mockResolvedValue({ id: 1 });

      const result = await mrCommand(
        ["review", "42", "--approve", "--body", "ship it"],
        ctx,
      );

      expect(execArgsOf()).toEqual(["mr", "approve", "42"]);
      expect(mockedApi).toHaveBeenCalledWith(
        "projects/:id/merge_requests/42/notes",
        { ctx, method: "POST", fields: { body: "ship it" } },
      );
      expect(result).toContain("action: approved");
    });

    it("revokes an approval", async () => {
      mockedExec.mockResolvedValue("");

      const result = await mrCommand(["review", "42", "--revoke"], ctx);

      expect(execArgsOf()).toEqual(["mr", "revoke", "42"]);
      expect(result).toContain("action: revoked");
      expect(mockedApi).not.toHaveBeenCalled();
    });

    it("requires a body for a comment-only review", async () => {
      await expect(
        mrCommand(["review", "42", "--comment"], ctx),
      ).rejects.toThrow(/--body or --body-file is required/);
    });

    it("rejects --approve together with --revoke", async () => {
      await expect(
        mrCommand(["review", "42", "--approve", "--revoke"], ctx),
      ).rejects.toThrow(/either --approve or --revoke/);
    });
  });

  describe("checks", () => {
    it("reports no pipeline when the head commit has none", async () => {
      mockedApi.mockResolvedValue(mrPayload({ head_pipeline: null }));

      const result = await mrCommand(["checks", "42"], ctx);

      expect(result).toContain("no pipeline ran for the head commit");
      expect(apiPathsOf()).toHaveLength(1);
    });

    it("summarises the head pipeline jobs and points at ci view on failure", async () => {
      mockedApi.mockResolvedValueOnce(mrPayload()).mockResolvedValueOnce([
        { name: "lint", stage: "linting", status: "success" },
        { name: "test", stage: "test", status: "failed" },
        { name: "scan", stage: "scan", status: "skipped" },
        { name: "deploy", stage: "deploy", status: "running" },
      ]);

      const result = await mrCommand(["checks", "42"], ctx);

      expect(apiPathsOf()[1]).toBe(
        "projects/:id/pipelines/777/jobs?per_page=100",
      );
      expect(result).toContain("pipeline: 777");
      expect(result).toContain(
        '"1 passed, 1 failed, 1 skipped, 1 pending, 4 total"',
      );
      expect(result).toContain("glab-axi ci view 777");
    });

    it("omits the ci view hint when nothing failed", async () => {
      mockedApi
        .mockResolvedValueOnce(mrPayload())
        .mockResolvedValueOnce([
          { name: "lint", stage: "linting", status: "success" },
        ]);

      const result = await mrCommand(["checks", "42"], ctx);

      expect(result).toContain('"1 passed, 0 failed, 1 total"');
      expect(result).not.toContain("ci view");
    });

    it("treats a canceled job as failing and a manual job as skipped", async () => {
      mockedApi.mockResolvedValueOnce(mrPayload()).mockResolvedValueOnce([
        { name: "a", status: "canceled" },
        { name: "b", status: "manual" },
      ]);

      const result = await mrCommand(["checks", "42"], ctx);

      expect(result).toContain('"0 passed, 1 failed, 1 skipped, 2 total"');
    });
  });

  describe("diff", () => {
    it("wraps the raw diff in a TOON envelope", async () => {
      mockedExec.mockResolvedValue("diff --git a/x b/x\n");

      const result = await mrCommand(["diff", "42"], ctx);

      expect(execArgsOf()).toEqual(["mr", "diff", "42", "--raw"]);
      expect(result).toContain("mr_diff");
      expect(result).toContain("iid: 42");
    });

    it("truncates a large diff and offers --full", async () => {
      mockedExec.mockResolvedValue("x".repeat(5000));

      const result = await mrCommand(["diff", "42"], ctx);

      expect(result).toContain("truncated: true");
      expect(result).toContain("original_length: 5000");
      expect(result).toContain("mr diff 42 --full -R group/sub/project");
    });

    it("skips truncation with --full", async () => {
      mockedExec.mockResolvedValue("x".repeat(5000));

      const result = await mrCommand(["diff", "42", "--full"], ctx);

      expect(result).not.toContain("truncated: true");
    });
  });

  describe("checkout", () => {
    it("reports the source branch read from the API", async () => {
      mockedApi.mockResolvedValue(mrPayload());
      mockedExec.mockResolvedValue("");

      const result = await mrCommand(["checkout", "42"], ctx);

      expect(execArgsOf()).toEqual(["mr", "checkout", "42"]);
      expect(result).toContain("branch: feat/widget");
    });
  });

  describe("rebase", () => {
    it("forwards --skip-ci", async () => {
      mockedExec.mockResolvedValue("");

      await mrCommand(["rebase", "42", "--skip-ci"], ctx);

      expect(execArgsOf()).toEqual(["mr", "rebase", "42", "--skip-ci"]);
    });
  });

  describe("--body-file", () => {
    it("posts file contents as a comment through the API", async () => {
      const body = "review\n```ts\nconst ok = true;\n```\n";
      await withBodyFile(body, async (file) => {
        mockedApi.mockResolvedValue({ id: 1 });

        const result = await mrCommand(
          ["comment", "42", "--body-file", file],
          ctx,
        );

        expect(mockedApi).toHaveBeenCalledWith(
          "projects/:id/merge_requests/42/notes",
          { ctx, method: "POST", fields: { body } },
        );
        expect(result).toContain("commented");
        expect(result).toContain("mr view 42 --comments");
      });
    });

    it("uses file contents for mr create", async () => {
      await withBodyFile("from file", async (file) => {
        mockedExec.mockResolvedValue(
          "https://gitlab.test/group/sub/project/-/merge_requests/42\n",
        );

        await mrCommand(["create", "--title", "T", "--body-file", file], ctx);

        expect(execArgsOf()).toContain("from file");
      });
    });

    it("rejects --body and --body-file together before calling glab", async () => {
      await withBodyFile("from file", async (file) => {
        await expect(
          mrCommand(
            ["comment", "42", "--body", "inline", "--body-file", file],
            ctx,
          ),
        ).rejects.toThrow(/only one/);
        expect(mockedApi).not.toHaveBeenCalled();
      });
    });

    it("requires a body for mr comment", async () => {
      await expect(mrCommand(["comment", "42"], ctx)).rejects.toThrow(
        /--body or --body-file is required/,
      );
    });
  });
});
