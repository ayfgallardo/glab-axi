import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabExec: vi.fn(),
  glabExecWithStdin: vi.fn(),
}));
vi.mock("../../src/stdin.js", () => ({
  isStdinTTY: vi.fn(() => false),
  readStdin: vi.fn(async () => ""),
}));

import { glabExec, glabExecWithStdin } from "../../src/glab.js";
import { isStdinTTY, readStdin } from "../../src/stdin.js";
import { apiCommand, API_HELP } from "../../src/commands/api.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

const mockedExec = vi.mocked(glabExec);
const mockedExecWithStdin = vi.mocked(glabExecWithStdin);
const mockedReadStdin = vi.mocked(readStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);

const ctx: RepoContext = { fullPath: "group/project", source: "flag" };

describe("apiCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("");
  });

  it("returns help without invoking glab", async () => {
    expect(await apiCommand([], ctx)).toBe(API_HELP);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("requires a path", async () => {
    await expect(apiCommand(["-X", "GET"], ctx)).rejects.toBeInstanceOf(
      AxiError,
    );
  });

  it("defaults to GET", async () => {
    mockedExec.mockResolvedValue('{"id":1}');

    await apiCommand(["projects/:id/issues"], ctx);

    expect(mockedExec).toHaveBeenCalledWith(
      ["api", "projects/:id/issues", "--method", "GET"],
      ctx,
    );
  });

  it("accepts a positional method", async () => {
    mockedExec.mockResolvedValue("{}");

    await apiCommand(["POST", "projects/:id/issues"], ctx);

    expect(mockedExec).toHaveBeenCalledWith(
      ["api", "projects/:id/issues", "--method", "POST"],
      ctx,
    );
  });

  it("rejects giving both -X and a positional method", async () => {
    await expect(
      apiCommand(["-X", "POST", "POST", "projects/:id/issues"], ctx),
    ).rejects.toThrow(/method given twice/);
  });

  it("forwards --field, --raw-field, and --header", async () => {
    mockedExec.mockResolvedValue("{}");

    await apiCommand(
      [
        "POST",
        "projects/:id/issues",
        "--field",
        "confidential=true",
        "--raw-field",
        "title=Bug",
        "--header",
        "X-Test:1",
      ],
      ctx,
    );

    expect(mockedExec).toHaveBeenCalledWith(
      [
        "api",
        "projects/:id/issues",
        "--method",
        "POST",
        "--field",
        "confidential=true",
        "--raw-field",
        "title=Bug",
        "--header",
        "X-Test:1",
      ],
      ctx,
    );
  });

  it("rejects an unknown flag instead of swallowing the next argument", async () => {
    await expect(
      apiCommand(["--jq", ".foo", "projects/:id/issues"], ctx),
    ).rejects.toThrow(/unknown flag --jq/);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("pipes stdin through for --input -", async () => {
    mockedReadStdin.mockResolvedValue('{"value":"bar"}');
    mockedExecWithStdin.mockResolvedValue("{}");

    await apiCommand(
      ["PUT", "projects/:id/variables/FOO", "--input", "-"],
      ctx,
    );

    expect(mockedExecWithStdin).toHaveBeenCalledWith(
      ["api", "projects/:id/variables/FOO", "--method", "PUT", "--input", "-"],
      '{"value":"bar"}',
      ctx,
    );
  });

  it("rejects --input - on a TTY", async () => {
    mockedIsStdinTTY.mockReturnValue(true);
    await expect(
      apiCommand(["PUT", "projects/:id/x", "--input", "-"], ctx),
    ).rejects.toBeInstanceOf(AxiError);
  });

  it("encodes a JSON response as TOON", async () => {
    mockedExec.mockResolvedValue('{"id":1,"title":"Bug"}');

    const output = await apiCommand(["projects/:id/issues/1"], ctx);

    expect(output).toContain("id: 1");
    expect(output).toContain("title: Bug");
  });

  it("truncates a long string field unless --full is given", async () => {
    const long = "a".repeat(3000);
    mockedExec.mockResolvedValue(JSON.stringify({ description: long }));

    const truncated = await apiCommand(["projects/:id/issues/1"], ctx);
    expect(truncated).toContain("(truncated)");

    mockedExec.mockResolvedValue(JSON.stringify({ description: long }));
    const full = await apiCommand(["projects/:id/issues/1", "--full"], ctx);
    expect(full).not.toContain("(truncated)");
  });

  it("wraps non-JSON output in an api_response envelope", async () => {
    mockedExec.mockResolvedValue("not json");

    const output = await apiCommand(["projects/:id/issues/1"], ctx);

    expect(output).toContain("body: not json");
    expect(output).toContain("truncated: false");
  });

  it("forwards --paginate", async () => {
    mockedExec.mockResolvedValue("[]");

    await apiCommand(["projects/:id/issues", "--paginate"], ctx);

    expect(mockedExec).toHaveBeenCalledWith(
      ["api", "projects/:id/issues", "--method", "GET", "--paginate"],
      ctx,
    );
  });

  it("supports the graphql endpoint", async () => {
    mockedExec.mockResolvedValue('{"data":{}}');

    await apiCommand(
      ["graphql", "--raw-field", "query=query { currentUser { id } }"],
      ctx,
    );

    expect(mockedExec).toHaveBeenCalledWith(
      [
        "api",
        "graphql",
        "--method",
        "GET",
        "--raw-field",
        "query=query { currentUser { id } }",
      ],
      ctx,
    );
  });
});
