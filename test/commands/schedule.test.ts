import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabExec: vi.fn(),
}));

import { glabApiJson, glabExec } from "../../src/glab.js";
import { scheduleCommand, SCHEDULE_HELP } from "../../src/commands/schedule.js";
import type { RepoContext } from "../../src/context.js";

const mockedApi = vi.mocked(glabApiJson);
const mockedExec = vi.mocked(glabExec);

const ctx: RepoContext = { fullPath: "group/sub/project", source: "flag" };

function apiPathsOf(): string[] {
  return mockedApi.mock.calls.map((call) => call[0] as string);
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 13,
    description: "Nightly build",
    ref: "refs/heads/main",
    cron: "0 2 * * *",
    cron_timezone: "UTC",
    next_run_at: "2026-09-01T02:00:00.000Z",
    active: true,
    owner: { username: "fgallardo" },
    ...overrides,
  };
}

describe("scheduleCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await scheduleCommand(["--help"])).toBe(SCHEDULE_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await scheduleCommand([])).toBe(SCHEDULE_HELP);
    });

    it("returns an error for an unknown subcommand", async () => {
      expect(await scheduleCommand(["unknown"])).toContain(
        "Unknown schedule subcommand: unknown",
      );
    });

    it("rejects an unknown flag", async () => {
      await expect(
        scheduleCommand(["list", "--bogus"], ctx),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });
  });

  describe("list", () => {
    it("lists schedules", async () => {
      mockedApi.mockResolvedValue([
        schedule(),
        schedule({ id: 14, description: "Weekly deploy", active: false }),
      ]);

      const result = await scheduleCommand(["list"], ctx);

      expect(apiPathsOf()[0]).toContain("projects/:id/pipeline_schedules?");
      expect(result).toContain("count: 2");
      expect(result).toContain("Nightly build");
      expect(result).toContain("Weekly deploy");
    });

    it("caps --limit at the GitLab per_page maximum of 100", async () => {
      mockedApi.mockResolvedValue([]);

      await scheduleCommand(["list", "--limit", "500"], ctx);

      expect(apiPathsOf()[0]).toContain("per_page=100");
    });

    it("forwards --scope", async () => {
      mockedApi.mockResolvedValue([]);

      await scheduleCommand(["list", "--scope", "active"], ctx);

      expect(apiPathsOf()[0]).toContain("scope=active");
    });
  });

  describe("view", () => {
    it("renders one schedule", async () => {
      mockedApi.mockResolvedValue(
        schedule({ variables: [{ key: "ENV", value: "prod" }] }),
      );

      const result = await scheduleCommand(["view", "13"], ctx);

      expect(apiPathsOf()[0]).toBe("projects/:id/pipeline_schedules/13");
      expect(result).toContain("Nightly build");
      expect(result).toContain("0 2 * * *");
    });

    it("requires a schedule id", async () => {
      await expect(scheduleCommand(["view"], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });
  });

  describe("run", () => {
    it("plays the schedule through glab", async () => {
      mockedExec.mockResolvedValue("Started schedule with ID 13\n");

      const result = await scheduleCommand(["run", "13"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(["schedule", "run", "13"], ctx);
      expect(result).toContain("triggered: ok");
      expect(result).toContain("13");
    });
  });

  describe("enable / disable", () => {
    it("enables an inactive schedule", async () => {
      mockedApi.mockResolvedValue(schedule({ active: false }));

      const result = await scheduleCommand(["enable", "13"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(
        ["schedule", "update", "13", "--active=true"],
        ctx,
      );
      expect(result).toContain("enable: ok");
    });

    it("is idempotent when the schedule is already active", async () => {
      mockedApi.mockResolvedValue(schedule({ active: true }));

      const result = await scheduleCommand(["enable", "13"], ctx);

      expect(mockedExec).not.toHaveBeenCalled();
      expect(result).toContain("enable: already_enabled");
    });

    it("disables an active schedule", async () => {
      mockedApi.mockResolvedValue(schedule({ active: true }));

      const result = await scheduleCommand(["disable", "13"], ctx);

      expect(mockedExec).toHaveBeenCalledWith(
        ["schedule", "update", "13", "--active=false"],
        ctx,
      );
      expect(result).toContain("disable: ok");
    });

    it("is idempotent when the schedule is already inactive", async () => {
      mockedApi.mockResolvedValue(schedule({ active: false }));

      const result = await scheduleCommand(["disable", "13"], ctx);

      expect(mockedExec).not.toHaveBeenCalled();
      expect(result).toContain("disable: already_disabled");
    });
  });
});
