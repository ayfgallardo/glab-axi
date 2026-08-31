import { describe, it, expect, afterEach } from "vitest";
import { snippetIdFromSelector } from "../src/snippetSelector.js";
import { AxiError } from "../src/errors.js";

afterEach(() => {
  delete process.env["GITLAB_HOST"];
});

describe("snippetIdFromSelector", () => {
  describe("bare ids", () => {
    it("returns a bare numeric id unchanged", () => {
      expect(snippetIdFromSelector("42")).toBe("42");
    });

    it("rejects a non-numeric bare id", () => {
      expect(() => snippetIdFromSelector("abc")).toThrow(AxiError);
    });
  });

  describe("urls", () => {
    it("extracts the id from a project snippet url", () => {
      expect(
        snippetIdFromSelector("https://gitlab.com/group/project/-/snippets/42"),
      ).toBe("42");
    });

    it("extracts the id from a personal snippet url", () => {
      expect(snippetIdFromSelector("https://gitlab.com/-/snippets/42")).toBe(
        "42",
      );
    });

    it("tolerates a trailing slash", () => {
      expect(
        snippetIdFromSelector(
          "https://gitlab.com/group/project/-/snippets/42/",
        ),
      ).toBe("42");
    });

    it("rejects a url on an unconfigured host", () => {
      expect(() =>
        snippetIdFromSelector("https://example.com/-/snippets/42"),
      ).toThrow(AxiError);
    });

    it("honors GITLAB_HOST for a self-managed instance", () => {
      process.env["GITLAB_HOST"] = "git.geofoncier.fr";
      expect(
        snippetIdFromSelector("https://git.geofoncier.fr/-/snippets/7"),
      ).toBe("7");
    });

    it("rejects a malformed url", () => {
      expect(() => snippetIdFromSelector("https://")).toThrow(AxiError);
    });
  });

  describe("input validation", () => {
    it("rejects an empty selector", () => {
      expect(() => snippetIdFromSelector("")).toThrow(AxiError);
    });

    it("rejects whitespace", () => {
      expect(() => snippetIdFromSelector("4 2")).toThrow(AxiError);
    });
  });
});
