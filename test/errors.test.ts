import { describe, it, expect } from "vitest";
import {
  AxiError,
  mapGlabError,
  glabNotInstalledError,
  exitCodeForError,
} from "../src/errors.js";

/** glab renders command errors inside a padded box on stderr. */
function boxed(message: string): string {
  return `          \n   ERROR  \n          \n  ${message}${" ".repeat(20)}\n\n`;
}

describe("AxiError", () => {
  it("has correct code and message", () => {
    const err = new AxiError("not found", "NOT_FOUND");
    expect(err.message).toBe("not found");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.name).toBe("AxiError");
    expect(err).toBeInstanceOf(Error);
  });

  it("has default empty suggestions", () => {
    const err = new AxiError("msg", "UNKNOWN");
    expect(err.suggestions).toEqual([]);
  });

  it("stores custom suggestions", () => {
    const err = new AxiError("msg", "NOT_FOUND", ["Try this", "Try that"]);
    expect(err.suggestions).toEqual(["Try this", "Try that"]);
  });
});

describe("mapGlabError", () => {
  it("matches the project-not-found form of a 404", () => {
    const err = mapGlabError("glab: 404 Project Not Found (HTTP 404)", 1);
    expect(err.code).toBe("REPO_NOT_FOUND");
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  it("matches the group-not-found form of a 404", () => {
    const err = mapGlabError("glab: 404 Group Not Found (HTTP 404)", 1);
    expect(err.code).toBe("REPO_NOT_FOUND");
  });

  it("matches a bare 404 as NOT_FOUND", () => {
    const err = mapGlabError(boxed("404 Not Found."), 1);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("404 Not Found.");
  });

  it("matches 401 as AUTH_REQUIRED", () => {
    const err = mapGlabError("glab: 401 Unauthorized (HTTP 401)", 1);
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.suggestions.some((s) => s.includes("glab auth login"))).toBe(
      true,
    );
  });

  it("matches a 401 embedded in an API URL error", () => {
    const err = mapGlabError(
      boxed(
        "Get https://gitlab.com/api/v4/projects/g%2Fp/variables: 401 {message: 401 Unauthorized}.",
      ),
      1,
    );
    expect(err.code).toBe("AUTH_REQUIRED");
  });

  it("matches glab's no-token message as AUTH_REQUIRED", () => {
    const err = mapGlabError(
      boxed(
        "X could not authenticate to one or more of the configured GitLab instances..",
      ),
      1,
    );
    expect(err.code).toBe("AUTH_REQUIRED");
  });

  it("matches 403 as FORBIDDEN", () => {
    const err = mapGlabError("glab: 403 Forbidden (HTTP 403)", 1);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("matches 429 as RATE_LIMITED", () => {
    const err = mapGlabError("glab: 429 Too Many Requests (HTTP 429)", 1);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  it("matches a 400 as VALIDATION_ERROR and extracts the API message", () => {
    const err = mapGlabError(
      'glab: 400 Bad Request (HTTP 400) {"message":"title is missing"}',
      1,
    );
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("title is missing");
  });

  it("matches a 422 as VALIDATION_ERROR", () => {
    const err = mapGlabError("glab: 422 Unprocessable (HTTP 422)", 1);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("returns NOT_FOUND for generic not found messages", () => {
    const err = mapGlabError("something not found", 1);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("returns UNKNOWN for unrecognized errors", () => {
    const err = mapGlabError("some random error", 1);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("some random error");
  });

  it("returns UNKNOWN with exit code message for empty stderr", () => {
    const err = mapGlabError("", 2);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toContain("exited with code 2");
  });

  it("skips glab's ERROR banner when reporting an unrecognized error", () => {
    const err = mapGlabError(boxed("some random error"), 1);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("some random error");
  });

  it("strips the `glab: ` prefix from API error lines", () => {
    const err = mapGlabError("glab: something odd happened", 1);
    expect(err.message).toBe("something odd happened");
  });

  it("uses first line of multi-line stderr for UNKNOWN errors", () => {
    const err = mapGlabError("first line\nsecond line\nthird line", 1);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("first line");
  });
});

describe("glabNotInstalledError", () => {
  it("returns AxiError with GLAB_NOT_INSTALLED code", () => {
    const err = glabNotInstalledError();
    expect(err).toBeInstanceOf(AxiError);
    expect(err.code).toBe("GLAB_NOT_INSTALLED");
    expect(err.message).toContain("glab CLI");
  });
});

describe("exitCodeForError", () => {
  it("returns 2 for VALIDATION_ERROR", () => {
    expect(exitCodeForError(new AxiError("bad", "VALIDATION_ERROR"))).toBe(2);
  });

  it.each([
    "NOT_FOUND",
    "REPO_NOT_FOUND",
    "AUTH_REQUIRED",
    "FORBIDDEN",
    "RATE_LIMITED",
    "GLAB_NOT_INSTALLED",
    "UNKNOWN",
  ])("returns 1 for %s", (code) => {
    expect(exitCodeForError(new AxiError("msg", code))).toBe(1);
  });

  it("returns 1 for non-AxiError", () => {
    expect(exitCodeForError(new Error("generic error"))).toBe(1);
  });
});
