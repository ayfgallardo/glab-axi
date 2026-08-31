import { describe, it, expect } from "vitest";
import { ISSUE_HELP } from "../src/commands/issue.js";
import { MR_HELP } from "../src/commands/mr.js";
import { CI_HELP } from "../src/commands/ci.js";
import { SCHEDULE_HELP } from "../src/commands/schedule.js";
import { RELEASE_HELP } from "../src/commands/release.js";
import { REPO_HELP } from "../src/commands/repo.js";
import { LABEL_HELP } from "../src/commands/label.js";
import { VARIABLE_HELP } from "../src/commands/variable.js";
import { SNIPPET_HELP } from "../src/commands/snippet.js";
import { STACK_HELP } from "../src/commands/stack.js";
import { API_HELP } from "../src/commands/api.js";
import { SETUP_HELP } from "../src/commands/setup.js";
import { TOP_HELP } from "../src/cli.js";

/**
 * Every HELP constant must contain an "examples:" section with at least 2
 * concrete usage examples that start with "glab-axi".
 */
function assertHelpHasExamples(name: string, help: string) {
  describe(`${name}`, () => {
    it("contains an examples: section", () => {
      expect(help).toContain("examples:");
    });

    it('has at least 2 examples starting with "glab-axi"', () => {
      const examplesSection = help.slice(help.indexOf("examples:"));
      const exampleLines = examplesSection
        .split("\n")
        .filter((line) => line.trim().startsWith("glab-axi"));
      expect(exampleLines.length).toBeGreaterThanOrEqual(2);
    });

    it("examples are indented with 2 spaces", () => {
      const examplesSection = help.slice(help.indexOf("examples:"));
      const exampleLines = examplesSection
        .split("\n")
        .filter((line) => line.trim().startsWith("glab-axi"));
      for (const line of exampleLines) {
        expect(line).toMatch(/^ {2}glab-axi/);
      }
    });
  });
}

describe("Help output includes examples for every command family", () => {
  assertHelpHasExamples("TOP_HELP", TOP_HELP);
  assertHelpHasExamples("ISSUE_HELP", ISSUE_HELP);
  assertHelpHasExamples("MR_HELP", MR_HELP);
  assertHelpHasExamples("CI_HELP", CI_HELP);
  assertHelpHasExamples("SCHEDULE_HELP", SCHEDULE_HELP);
  assertHelpHasExamples("RELEASE_HELP", RELEASE_HELP);
  assertHelpHasExamples("REPO_HELP", REPO_HELP);
  assertHelpHasExamples("LABEL_HELP", LABEL_HELP);
  assertHelpHasExamples("VARIABLE_HELP", VARIABLE_HELP);
  assertHelpHasExamples("SNIPPET_HELP", SNIPPET_HELP);
  assertHelpHasExamples("STACK_HELP", STACK_HELP);
  assertHelpHasExamples("API_HELP", API_HELP);
  assertHelpHasExamples("SETUP_HELP", SETUP_HELP);
});

describe("--body-file discoverability", () => {
  it("documents --body-file in body-accepting command help", () => {
    expect(ISSUE_HELP).toContain("--body-file <path>");
    expect(MR_HELP).toContain("--body-file <path>");
    expect(RELEASE_HELP).toContain("--body-file");
  });
});

describe("SNIPPET_HELP subcommands", () => {
  it("declares exactly 5 subcommands", () => {
    expect(SNIPPET_HELP).toContain("subcommands[5]:");
  });

  it("names all five subcommands: list, view, create, edit, delete", () => {
    const lines = SNIPPET_HELP.split("\n");
    const headerIdx = lines.findIndex((l) => l.includes("subcommands[5]:"));
    expect(headerIdx).toBeGreaterThan(-1);
    const namesCombined = lines.slice(headerIdx, headerIdx + 2).join(" ");
    expect(namesCombined).toContain("list");
    expect(namesCombined).toContain("view");
    expect(namesCombined).toContain("create");
    expect(namesCombined).toContain("edit");
    expect(namesCombined).toContain("delete");
  });
});

describe("variable --scope discoverability", () => {
  it("documents the --scope environment flag in variable help", () => {
    expect(VARIABLE_HELP).toContain("--scope <environment>");
  });
});
