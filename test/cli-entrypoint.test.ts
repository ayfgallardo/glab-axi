import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

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

    await main({ argv: ["label", "list"], stdout: output.stdout });

    expect(output.read()).toContain("not ported yet");
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("posts mr comment --body-file contents through the real runtime", async () => {
    const body = "review\n```ts\nconst ok = true;\n```\nIt's ready.";
    const dir = mkdtempSync(join(tmpdir(), "glab-axi-entrypoint-"));
    const file = join(dir, "body.md");
    writeFileSync(file, body, "utf8");

    try {
      mockedExecFileSync.mockReturnValue("git@gitlab.com:group/project.git\n");
      mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(null, '{"id":1}', "");
        return {} as ReturnType<typeof execFile>;
      });
      const output = createStdout();

      await main({
        argv: ["mr", "comment", "123", "--body-file", file],
        stdout: output.stdout,
      });

      expect(mockedExecFile).toHaveBeenCalledWith(
        "glab",
        [
          "api",
          "projects/group%2Fproject/merge_requests/123/notes",
          "--method",
          "POST",
          "--raw-field",
          `body=${body}`,
        ],
        expect.any(Object),
        expect.any(Function),
      );
      expect(output.read()).toContain("commented");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
