import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axi-sdk-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axi-sdk-js")>();
  return { ...actual, installSessionStartHooks: vi.fn() };
});

import { installSessionStartHooks } from "axi-sdk-js";
import { setupCommand } from "../../src/commands/setup.js";

const mockedInstall = vi.mocked(installSessionStartHooks);

describe("setupCommand", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a missing action rather than installing hooks", async () => {
    await expect(setupCommand([])).rejects.toThrow(/Unknown setup action/);
    expect(mockedInstall).not.toHaveBeenCalled();
  });

  it("installs SessionStart hooks for the hooks action", async () => {
    const output = await setupCommand(["hooks"]);

    expect(mockedInstall).toHaveBeenCalledTimes(1);
    expect(output).toContain("status: installed");
  });

  it("rejects an unknown action", async () => {
    await expect(setupCommand(["bogus"])).rejects.toThrow(
      /Unknown setup action/,
    );
    expect(mockedInstall).not.toHaveBeenCalled();
  });
});
