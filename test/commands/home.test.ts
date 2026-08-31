import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
}));

import { glabApiJson } from "../../src/glab.js";
import { homeCommand } from "../../src/commands/home.js";

const mockedApi = vi.mocked(glabApiJson);

function apiPathsOf(): string[] {
  return mockedApi.mock.calls.map((call) => call[0] as string);
}

describe("homeCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads /user, assigned merge requests, assigned issues and todos in parallel", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "user") return { username: "fgallardo" };
      if (path.startsWith("merge_requests")) {
        return [{ iid: 1, title: "Fix widget", author: { username: "alice" } }];
      }
      if (path.startsWith("issues")) {
        return [{ iid: 2, title: "Report bug", author: { username: "bob" } }];
      }
      if (path.startsWith("todos")) {
        return [
          {
            action_name: "assigned",
            target_type: "MergeRequest",
            project: { path_with_namespace: "group/project" },
          },
        ];
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await homeCommand([]);

    expect(apiPathsOf()).toEqual([
      "user",
      "merge_requests?scope=assigned_to_me&state=opened&per_page=3",
      "issues?scope=assigned_to_me&state=opened&per_page=3",
      "todos?per_page=3",
    ]);
    expect(result).toContain("fgallardo");
    expect(result).toContain("Fix widget");
    expect(result).toContain("Report bug");
    expect(result).toContain("group/project");
  });

  it("renders empty-state lines when nothing is assigned", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "user") return { username: "fgallardo" };
      return [];
    });

    const result = await homeCommand([]);

    expect(result).toContain("assigned_mrs: 0 open");
    expect(result).toContain("assigned_issues: 0 open");
    expect(result).toContain("todos: 0 pending");
  });

  it("does not fail the whole dashboard when one endpoint rejects", async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === "user") throw new Error("boom");
      return [];
    });

    const result = await homeCommand([]);

    expect(result).toContain("assigned_mrs: 0 open");
  });
});
