import { describe, it, expect } from "vitest";
import { getSuggestions, withSuggestionHost } from "../src/suggestions.js";

describe("getSuggestions", () => {
  it("returns home suggestions", () => {
    const lines = getSuggestions({ domain: "home", action: "home" });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("issue") || l.includes("mr"))).toBe(
      true,
    );
  });

  it("returns issue list suggestions when non-empty", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
    });
    expect(lines.some((l) => l.includes("issue view"))).toBe(true);
  });

  it("returns issue list suggestions when empty", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: true,
    });
    expect(lines.some((l) => l.includes("issue create"))).toBe(true);
    expect(lines.some((l) => l.includes("--state closed"))).toBe(true);
  });

  it("returns open issue view suggestions", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "view",
      state: "open",
      id: 42,
    });
    expect(lines.some((l) => l.includes("comment 42"))).toBe(true);
    expect(lines.some((l) => l.includes("close 42"))).toBe(true);
  });

  it("returns closed issue view suggestions", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "view",
      state: "closed",
      id: 42,
    });
    expect(lines.some((l) => l.includes("reopen 42"))).toBe(true);
  });

  it("carries -R flag when repo source is not git", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      repo: { fullPath: "group/project", source: "flag" },
    });
    expect(lines.every((l) => l.includes("-R group/project"))).toBe(true);
    expect(lines.every((l) => !l.includes("glab-axi -R"))).toBe(true);
    expect(lines).toContain(
      "Run `glab-axi issue view <iid> -R group/project` to view details",
    );
  });

  it("carries explicit non-default hostname flags", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      repo: {
        fullPath: "group/project",
        source: "flag",
        host: { value: "git.geofoncier.fr", source: "flag" },
      },
    });

    expect(lines).toEqual([
      "Run `glab-axi issue view <iid> -R group/project --hostname git.geofoncier.fr` to view details",
      'Run `glab-axi issue create --title "..." --body-file <path> -R group/project --hostname git.geofoncier.fr` to create',
    ]);
  });

  it("does not carry env-only hostname flags", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      host: { value: "git.geofoncier.fr", source: "env" },
    });

    expect(lines.every((l) => !l.includes("--hostname"))).toBe(true);
  });

  it("does not carry default hostname flags", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      host: { value: "gitlab.com", source: "flag" },
    });

    expect(lines.every((l) => !l.includes("--hostname"))).toBe(true);
  });

  it("carries host-only CLI context into suggestions", async () => {
    const lines = await withSuggestionHost(
      { value: "git.geofoncier.fr", source: "flag" },
      async () =>
        getSuggestions({
          domain: "issue",
          action: "list",
          isEmpty: false,
        }),
    );

    expect(lines).toContain(
      "Run `glab-axi issue view <iid> --hostname git.geofoncier.fr` to view details",
    );
  });

  it("does not carry -R flag when repo source is git", () => {
    const lines = getSuggestions({
      domain: "issue",
      action: "list",
      isEmpty: false,
      repo: { fullPath: "group/project", source: "git" },
    });
    expect(lines.every((l) => !l.includes("-R"))).toBe(true);
  });

  it("places explicit repo flags after variable commands", () => {
    const repo = { fullPath: "group/project", source: "flag" as const };

    const lines = [
      ...getSuggestions({
        domain: "variable",
        action: "list",
        isEmpty: false,
        repo,
      }),
      ...getSuggestions({
        domain: "variable",
        action: "list",
        isEmpty: true,
        repo,
      }),
      ...getSuggestions({ domain: "variable", action: "set", repo }),
      ...getSuggestions({ domain: "variable", action: "delete", repo }),
    ];

    expect(lines).toEqual([
      'Run `echo -n "<value>" | glab-axi variable set <name> -R group/project` to add or update a variable',
      'Run `echo -n "<value>" | glab-axi variable set <name> -R group/project` to add a variable',
      "Run `glab-axi variable list -R group/project` to see all variables",
      "Run `glab-axi variable list -R group/project` to see remaining variables",
    ]);
    expect(lines.every((l) => !l.includes("glab-axi -R"))).toBe(true);
  });

  it("returns snippet list and view suggestions", () => {
    const listed = getSuggestions({
      domain: "snippet",
      action: "list",
      isEmpty: false,
    });
    expect(listed.some((l) => l.includes("snippet view"))).toBe(true);

    const viewed = getSuggestions({
      domain: "snippet",
      action: "view",
      id: 42,
    });
    expect(viewed.some((l) => l.includes("view 42 --files"))).toBe(true);
  });

  it("returns no suggestions for api and stack", () => {
    expect(getSuggestions({ domain: "api", action: "call" })).toEqual([]);
    expect(getSuggestions({ domain: "stack", action: "sync" })).toEqual([]);
  });

  it("returns an empty list for an unrecognized domain/action", () => {
    expect(getSuggestions({ domain: "bogus", action: "bogus" })).toEqual([]);
  });
});
