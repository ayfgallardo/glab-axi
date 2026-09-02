import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repoRoot, "bin", "glab-axi.ts");
const fakeGlab = fileURLToPath(
  new URL("../fixtures/stateful-glab.mjs", import.meta.url),
);

type FakeState = {
  releases: Array<{
    tag_name: string;
    name: string;
    description: string | null;
  }>;
};

function initialState(): FakeState {
  return {
    releases: [{ tag_name: "v1.0.0", name: "Version 1", description: null }],
  };
}

describe("CLI release and API state round-trips", () => {
  let dir: string;
  let stateFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glab-axi-stateful-glab-"));
    stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify(initialState()), "utf8");
    const fakeBin = join(dir, "glab");
    copyFileSync(fakeGlab, fakeBin);
    chmodSync(fakeBin, 0o755);
    env = {
      ...process.env,
      GLAB_AXI_FAKE_STATE: stateFile,
      // The suite spawns the real binary; without this it would append fake
      // measurements to the developer's own gain log.
      AXI_GAIN: "0",
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runCli(...args: string[]): string {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, ...args, "-R", "group/project"],
      { cwd: repoRoot, encoding: "utf8", env },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    return result.stdout;
  }

  function readReleaseViaApi(): string {
    return runCli("api", "projects/:id/releases/v1.0.0");
  }

  it("persists a release edit and reads it back via release view", () => {
    runCli("release", "edit", "v1.0.0", "--title", "Renamed via CLI");

    const view = runCli("release", "view", "v1.0.0");
    expect(view).toContain("name: Renamed via CLI");
  });

  it("persists an API PATCH for a subsequent API GET", () => {
    runCli(
      "api",
      "PATCH",
      "projects/:id/releases/v1.0.0",
      "--field",
      "name=Renamed via API",
    );

    expect(readReleaseViaApi()).toContain("name: Renamed via API");
  });

  it("persists release edit notes readable through the raw API", () => {
    runCli("release", "edit", "v1.0.0", "--body", "updated notes");

    expect(readReleaseViaApi()).toContain("description: updated notes");
  });
});
