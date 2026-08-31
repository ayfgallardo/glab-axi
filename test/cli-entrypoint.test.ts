import { readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, TOP_HELP } from "../src/cli.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const mockedExecFile = vi.mocked(execFile);
const mockedExecFileSync = vi.mocked(execFileSync);

function createStdout() {
  let output = "";

  return {
    stdout: {
      write(chunk: string) {
        output += chunk;
      },
    },
    read() {
      return output;
    },
  };
}

describe("CLI entrypoint", () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("prints top-level help through the real runtime", async () => {
    const output = createStdout();

    await main({ argv: ["--help"], stdout: output.stdout });

    // The runtime renders TOP_HELP, then the SDK appends the inherited
    // built-in commands (the self-update `update` command).
    const rendered = output.read();
    expect(rendered.startsWith(TOP_HELP)).toBe(true);
    expect(rendered).toContain('"built-in":');
    expect(rendered).toContain("update --check");
  });

  it.each(["-v", "-V", "--version"])(
    "prints %s through the real runtime",
    async (flag) => {
      const output = createStdout();

      await main({ argv: [flag], stdout: output.stdout });

      expect(output.read()).toBe(`${packageVersion.version}\n`);
    },
  );

  it("reports an unknown command through the real runtime", async () => {
    const output = createStdout();

    await main({ argv: ["gist", "list"], stdout: output.stdout });

    expect(output.read()).toContain("Unknown command: gist");
    expect(process.exitCode).toBe(2);
  });

  it("surfaces a not-yet-ported command as a structured error", async () => {
    mockedExecFileSync.mockReturnValue("git@gitlab.com:group/project.git\n");
    const output = createStdout();

    await main({ argv: ["issue", "list"], stdout: output.stdout });

    expect(output.read()).toContain("not ported yet");
    expect(mockedExecFile).not.toHaveBeenCalled();
  });
});
