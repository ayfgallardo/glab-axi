import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../src/stdin.js", () => ({
  readStdin: vi.fn(),
  isStdinTTY: vi.fn(),
}));

import { readStdin, isStdinTTY } from "../src/stdin.js";
import { resolveValue } from "../src/secretValue.js";
import { AxiError } from "../src/errors.js";

const mockedReadStdin = vi.mocked(readStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);

describe("resolveValue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a variable flag value: values are stdin-only, glab-axi has no --body flag", async () => {
    await expect(resolveValue("production", "variable")).rejects.toThrow(
      "variable values must be piped via stdin; a flag value is not accepted",
    );
    expect(mockedReadStdin).not.toHaveBeenCalled();
    expect(mockedIsStdinTTY).not.toHaveBeenCalled();
  });

  it("rejects a secret flag value the same way", async () => {
    await expect(resolveValue("sk-flag-value", "secret")).rejects.toThrow(
      "secret values must be piped via stdin; a flag value is not accepted",
    );
    expect(mockedReadStdin).not.toHaveBeenCalled();
    expect(mockedIsStdinTTY).not.toHaveBeenCalled();
  });

  it("reads from stdin when no flag value is given and stdin is piped", async () => {
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("piped-value");

    const value = await resolveValue(undefined, "variable");

    expect(value).toBe("piped-value");
    expect(mockedReadStdin).toHaveBeenCalledTimes(1);
  });

  it("throws instead of blocking when stdin is an interactive TTY", async () => {
    mockedIsStdinTTY.mockReturnValue(true);

    await expect(resolveValue(undefined, "secret")).rejects.toThrow(AxiError);
    expect(mockedReadStdin).not.toHaveBeenCalled();
  });

  it("names the exact glab-axi stdin command for a missing secret value", async () => {
    mockedIsStdinTTY.mockReturnValue(true);

    await expect(resolveValue(undefined, "secret")).rejects.toMatchObject({
      message: "secret value is required: pipe the value via stdin",
      suggestions: ['echo -n "<value>" | glab-axi secret set <name>'],
    });
  });

  it("names the exact glab-axi stdin command for a missing variable value, with no --body mentioned", async () => {
    mockedIsStdinTTY.mockReturnValue(true);

    await expect(resolveValue(undefined, "variable")).rejects.toMatchObject({
      message: "variable value is required: pipe the value via stdin",
      suggestions: ['echo -n "<value>" | glab-axi variable set <name>'],
    });
    await expect(resolveValue(undefined, "variable")).rejects.not.toThrow(
      "--body",
    );
    await expect(resolveValue(undefined, "variable")).rejects.not.toThrow(
      "gh-axi",
    );
  });

  it("throws when piped stdin is empty", async () => {
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("");

    await expect(resolveValue(undefined, "secret")).rejects.toThrow(AxiError);
  });
});
