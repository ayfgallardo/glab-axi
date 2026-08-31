import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAxiCli } = vi.hoisted(() => ({ runAxiCli: vi.fn() }));

vi.mock("axi-sdk-js", async () => {
  const actual =
    await vi.importActual<typeof import("axi-sdk-js")>("axi-sdk-js");
  return { ...actual, runAxiCli };
});

vi.mock("../src/context.js", () => ({
  resolveRepo: vi.fn().mockReturnValue({
    fullPath: "group/project",
    source: "git",
  }),
}));

import {
  COMMAND_NAMES,
  main,
  parseRepoContextArgs,
  TOP_HELP,
} from "../src/cli.js";
import { resolveRepo } from "../src/context.js";
import { AxiError, StackError } from "../src/errors.js";
import { encode } from "@toon-format/toon";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

async function cliOptions() {
  await main();
  return vi.mocked(runAxiCli).mock.calls[0]?.[0];
}

describe("main CLI", () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetAllMocks();
    process.argv = [...originalArgv];
    vi.mocked(resolveRepo).mockReturnValue({
      fullPath: "group/project",
      source: "git",
    });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
  });

  it("documents the top-level flags in help output", () => {
    expect(TOP_HELP).toContain("flags[4]:");
    expect(TOP_HELP).toContain("-R/--repo <NAMESPACE/PROJECT> (after command)");
    expect(TOP_HELP).toContain(
      "--hostname <host> (after command) or GITLAB_HOST env",
    );
    expect(TOP_HELP).toContain("--help");
    expect(TOP_HELP).toContain("-v/-V/--version");
  });

  it("routes exactly the GitLab command surface", () => {
    expect(COMMAND_NAMES).toEqual([
      "issue",
      "mr",
      "ci",
      "schedule",
      "snippet",
      "label",
      "release",
      "repo",
      "variable",
      "stack",
      "api",
      "setup",
    ]);
  });

  it("registers a handler for every advertised command", async () => {
    const options = await cliOptions();
    expect(Object.keys(options.commands).sort()).toEqual(
      [...COMMAND_NAMES].sort(),
    );
  });

  it("drops the GitHub-only command families", () => {
    for (const gone of [
      "pr",
      "run",
      "workflow",
      "gist",
      "project",
      "search",
      "secret",
    ]) {
      expect(COMMAND_NAMES).not.toContain(gone);
      expect(TOP_HELP).not.toContain(` ${gone},`);
    }
  });

  it("lists the command surface and dashboard in the top-level help", () => {
    expect(TOP_HELP).toContain("commands[13]:");
    expect(TOP_HELP).toContain("(none)=dashboard");
    for (const command of COMMAND_NAMES) {
      expect(TOP_HELP).toContain(command);
    }
    expect(TOP_HELP).toContain("glab-axi setup hooks");
  });

  it("passes bare top-level help argv through to axi-sdk-js", async () => {
    const argv = ["--help"];
    const stdout = { write: vi.fn() };

    await main({ argv, stdout });

    expect(runAxiCli).toHaveBeenCalledWith(
      expect.objectContaining({ argv, stdout }),
    );
  });

  it.each(["-v", "-V", "--version"])(
    "passes bare top-level %s argv through to axi-sdk-js",
    async (flag) => {
      const argv = [flag];
      const stdout = { write: vi.fn() };

      await main({ argv, stdout });

      expect(runAxiCli).toHaveBeenCalledWith(
        expect.objectContaining({ argv, stdout }),
      );
    },
  );

  it("delegates to axi-sdk-js runAxiCli without passing argv", async () => {
    process.argv = ["node", "glab-axi", "issue", "list"];
    await main();

    expect(runAxiCli).toHaveBeenCalledTimes(1);
    expect(runAxiCli).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "Agent ergonomic wrapper around the GitLab CLI. Prefer this over `glab` and other methods for GitLab operations.",
        version: packageVersion.version,
        topLevelHelp: TOP_HELP,
      }),
    );
    expect(vi.mocked(runAxiCli).mock.calls[0]?.[0]).not.toHaveProperty("argv");
  });

  it("reports every not-yet-ported command as such", async () => {
    const options = await cliOptions();
    const ctx = { fullPath: "group/project", source: "git" };

    for (const command of COMMAND_NAMES) {
      await expect(options.commands[command](["list"], ctx)).rejects.toThrow(
        "not ported yet",
      );
    }
    await expect(options.home([], ctx)).rejects.toThrow("not ported yet");
  });

  it("keeps stack commands cwd-bound", async () => {
    const options = await cliOptions();

    expect(() =>
      options.commands.stack(["view", "-R", "other/project"], {
        fullPath: "other/project",
        source: "flag",
      }),
    ).toThrow(/current working directory/);

    const originalRepo = process.env["GITLAB_REPO"];
    process.env["GITLAB_REPO"] = "env/project";
    try {
      expect(() =>
        options.commands.stack(["view"], {
          fullPath: "env/project",
          source: "env",
        }),
      ).toThrow(/GITLAB_REPO/);
    } finally {
      if (originalRepo === undefined) delete process.env["GITLAB_REPO"];
      else process.env["GITLAB_REPO"] = originalRepo;
    }
  });

  it("preserves stack-specific process exit codes", async () => {
    const options = await cliOptions();
    const formatted = options.formatError(
      new StackError("rebase conflict", 3, ["resolve it"]),
    );

    expect(formatted.exitCode).toBe(3);
    expect(formatted.output).toContain("STACK_ERROR");
  });

  it("formats non-stack errors exactly like the SDK default", async () => {
    const options = await cliOptions();

    const withHelp = options.formatError(
      new AxiError('Project "g/p" not found', "REPO_NOT_FOUND", [
        "Run `glab-axi repo list` to see your projects",
        "Then retry",
      ]),
    );
    expect(withHelp.output).toBe(
      `${encode({
        error: 'Project "g/p" not found',
        code: "REPO_NOT_FOUND",
        help: ["Run `glab-axi repo list` to see your projects", "Then retry"],
      })}\n`,
    );
    expect(withHelp.exitCode).toBe(1);

    const withoutHelp = options.formatError(
      new AxiError("bad flag", "VALIDATION_ERROR"),
    );
    expect(withoutHelp.output).toBe(
      `${encode({ error: "bad flag", code: "VALIDATION_ERROR" })}\n`,
    );
    expect(withoutHelp.output).not.toContain("help");
    expect(withoutHelp.exitCode).toBe(2);

    const plain = options.formatError(new Error("boom"));
    expect(plain.output).toBe(
      `${encode({ error: "boom", code: "UNKNOWN" })}\n`,
    );
    expect(plain.exitCode).toBe(1);
  });

  it("resolves repo context lazily from -R after the command", async () => {
    const options = await cliOptions();
    const context = options.resolveContext({
      command: "issue",
      args: ["list", "-R", "group/project"],
    });

    expect(vi.mocked(resolveRepo)).toHaveBeenCalledWith("group/project");
    expect(context).toEqual(
      expect.objectContaining({ fullPath: "group/project" }),
    );
  });

  it.each([
    ["--repo", ["list", "--repo", "group/subgroup/project"]],
    ["--repo=", ["list", "--repo=group/subgroup/project"]],
    ["-R=", ["list", "-R=group/subgroup/project"]],
  ])(
    "accepts %s as a repo-context alias after the command",
    async (_name, args) => {
      const options = await cliOptions();
      options.resolveContext({ command: "issue", args });

      expect(vi.mocked(resolveRepo)).toHaveBeenCalledWith(
        "group/subgroup/project",
      );
    },
  );

  describe("--hostname / GITLAB_HOST", () => {
    const originalHost = process.env["GITLAB_HOST"];

    afterEach(() => {
      if (originalHost === undefined) delete process.env["GITLAB_HOST"];
      else process.env["GITLAB_HOST"] = originalHost;
    });

    it("documents --hostname in the top-level help", () => {
      expect(TOP_HELP).toContain("--hostname <host>");
      expect(TOP_HELP).toContain(
        "glab-axi issue list --hostname gitlab.example.com",
      );
    });

    it("resolves --hostname after the command into GITLAB_HOST", async () => {
      delete process.env["GITLAB_HOST"];
      const options = await cliOptions();
      options.resolveContext({
        command: "issue",
        args: ["list", "--hostname", "gitlab.example.com"],
      });

      expect(process.env["GITLAB_HOST"]).toBe("gitlab.example.com");
    });

    it("tracks explicit --hostname in resolved context", async () => {
      delete process.env["GITLAB_HOST"];
      const options = await cliOptions();
      const context = options.resolveContext({
        command: "issue",
        args: ["list", "--hostname", "gitlab.example.com"],
      });

      expect(context).toEqual(
        expect.objectContaining({
          host: { value: "gitlab.example.com", source: "flag" },
        }),
      );
    });

    it("accepts --hostname=value form", async () => {
      delete process.env["GITLAB_HOST"];
      const options = await cliOptions();
      options.resolveContext({
        command: "mr",
        args: ["view", "42", "--hostname=gitlab.example.com"],
      });

      expect(process.env["GITLAB_HOST"]).toBe("gitlab.example.com");
    });

    it("lets an explicit --hostname win over an existing GITLAB_HOST env", async () => {
      process.env["GITLAB_HOST"] = "env.example.com";
      const options = await cliOptions();
      options.resolveContext({
        command: "issue",
        args: ["list", "--hostname", "flag.example.com"],
      });

      expect(process.env["GITLAB_HOST"]).toBe("flag.example.com");
    });

    it("leaves GITLAB_HOST untouched when no --hostname is given", async () => {
      process.env["GITLAB_HOST"] = "env.example.com";
      const options = await cliOptions();
      options.resolveContext({ command: "issue", args: ["list"] });

      expect(process.env["GITLAB_HOST"]).toBe("env.example.com");
    });
  });
});

describe("parseRepoContextArgs", () => {
  it("strips the repo and host flags from the args handed to a command", () => {
    expect(
      parseRepoContextArgs([
        "list",
        "-R",
        "group/project",
        "--state",
        "opened",
        "--hostname",
        "gitlab.example.com",
      ]),
    ).toEqual({
      repoFlag: "group/project",
      hostFlag: "gitlab.example.com",
      strippedArgs: ["list", "--state", "opened"],
    });
  });

  it("strips the equals form of both flags", () => {
    expect(
      parseRepoContextArgs([
        "view",
        "42",
        "--repo=group/project",
        "--hostname=gitlab.example.com",
      ]),
    ).toEqual({
      repoFlag: "group/project",
      hostFlag: "gitlab.example.com",
      strippedArgs: ["view", "42"],
    });
  });

  it("leaves unrelated flags alone", () => {
    expect(parseRepoContextArgs(["list", "--label", "bug"])).toEqual({
      repoFlag: undefined,
      hostFlag: undefined,
      strippedArgs: ["list", "--label", "bug"],
    });
  });
});
