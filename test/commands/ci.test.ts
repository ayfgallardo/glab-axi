import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../../src/glab.js", () => ({
  glabApiJson: vi.fn(),
  glabApiText: vi.fn(),
  glabExec: vi.fn(),
}));

vi.mock("../../src/context.js", () => ({
  resolveCurrentBranch: vi.fn(),
}));

import { glabApiJson, glabApiText, glabExec } from "../../src/glab.js";
import { resolveCurrentBranch } from "../../src/context.js";
import { ciCommand, CI_HELP } from "../../src/commands/ci.js";
import { AxiError } from "../../src/errors.js";
import type { RepoContext } from "../../src/context.js";

const mockedApi = vi.mocked(glabApiJson);
const mockedText = vi.mocked(glabApiText);
const mockedExec = vi.mocked(glabExec);
const mockedBranch = vi.mocked(resolveCurrentBranch);

const ctx: RepoContext = { fullPath: "group/sub/project", source: "flag" };

function apiPathsOf(): string[] {
  return mockedApi.mock.calls.map((call) => call[0] as string);
}

function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 52377,
    iid: 111,
    status: "success",
    source: "push",
    ref: "main",
    sha: "91f3a11f1dc6ed49f5e21c2b9e359690bf0a50b5",
    created_at: "2026-08-27T21:53:35.047Z",
    updated_at: "2026-08-27T21:56:23.360Z",
    duration: 165,
    web_url: "https://gitlab.example.com/group/sub/project/-/pipelines/52377",
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 199506,
    name: "build",
    stage: "build",
    status: "success",
    allow_failure: false,
    duration: 42,
    web_url: "https://gitlab.example.com/group/sub/project/-/jobs/199506",
    ...overrides,
  };
}

describe("ciCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await ciCommand(["--help"])).toBe(CI_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await ciCommand([])).toBe(CI_HELP);
    });

    it("returns an error for an unknown subcommand", async () => {
      expect(await ciCommand(["unknown"])).toContain(
        "Unknown ci subcommand: unknown",
      );
    });

    it("rejects an unknown flag", async () => {
      await expect(ciCommand(["list", "--bogus"], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });
  });

  describe("list", () => {
    it("lists pipelines by their visible id", async () => {
      mockedApi.mockResolvedValue([
        pipeline(),
        pipeline({ id: 52376, status: "failed", ref: "renovate/uv" }),
      ]);

      const result = await ciCommand(["list"], ctx);

      expect(apiPathsOf()[0]).toContain("projects/:id/pipelines?");
      expect(result).toContain("count: 2");
      expect(result).toContain("52377");
      expect(result).toContain("renovate/uv");
    });

    it("defaults per_page to 20 and forwards filters", async () => {
      mockedApi.mockResolvedValue([]);

      await ciCommand(
        ["list", "--status", "failed", "--ref", "main", "--source", "push"],
        ctx,
      );

      const path = apiPathsOf()[0];
      expect(path).toContain("per_page=20");
      expect(path).toContain("status=failed");
      expect(path).toContain("ref=main");
      expect(path).toContain("source=push");
    });

    it("caps --limit at the GitLab per_page maximum of 100", async () => {
      mockedApi.mockResolvedValue([]);

      await ciCommand(["list", "--limit", "500"], ctx);

      expect(apiPathsOf()[0]).toContain("per_page=100");
    });

    it("extends the schema when --fields is passed", async () => {
      mockedApi.mockResolvedValue([pipeline()]);

      const result = await ciCommand(["list", "--fields", "sha,url"], ctx);

      expect(result).toContain("91f3a11f");
      expect(result).toContain("/-/pipelines/52377");
    });

    it("throws VALIDATION_ERROR for an unknown --fields entry", async () => {
      await expect(
        ciCommand(["list", "--fields", "bogusField"], ctx),
      ).rejects.toThrow(AxiError);
    });
  });

  describe("status", () => {
    it("reads the most recent pipeline of the current branch", async () => {
      mockedBranch.mockReturnValue("feat/x");
      mockedApi
        .mockResolvedValueOnce([pipeline()])
        .mockResolvedValueOnce([job()]);

      const result = await ciCommand(["status"], ctx);

      expect(apiPathsOf()[0]).toBe(
        "projects/:id/pipelines?per_page=1&ref=feat%2Fx",
      );
      expect(result).toContain("52377");
      expect(result).toContain("build");
    });

    it("scopes to --branch over the checkout", async () => {
      mockedBranch.mockReturnValue("feat/x");
      mockedApi.mockResolvedValueOnce([pipeline()]).mockResolvedValueOnce([]);

      await ciCommand(["status", "--branch", "main"], ctx);

      expect(apiPathsOf()[0]).toBe("projects/:id/pipelines?per_page=1&ref=main");
    });

    it("leaves the query unfiltered outside a checkout", async () => {
      mockedBranch.mockReturnValue(undefined);
      mockedApi.mockResolvedValueOnce([pipeline()]).mockResolvedValueOnce([]);

      await ciCommand(["status"], ctx);

      expect(apiPathsOf()[0]).toBe("projects/:id/pipelines?per_page=1");
    });

    it("reports a ref without any pipeline instead of failing", async () => {
      mockedBranch.mockReturnValue("feat/x");
      mockedApi.mockResolvedValueOnce([]);

      const result = await ciCommand(["status"], ctx);

      expect(result).toContain("no pipeline for feat/x");
      expect(mockedApi).toHaveBeenCalledTimes(1);
    });

    it("suggests reading the log of a failed job", async () => {
      mockedBranch.mockReturnValue("main");
      mockedApi
        .mockResolvedValueOnce([pipeline({ status: "failed" })])
        .mockResolvedValueOnce([
          job(),
          job({ id: 199507, name: "test", status: "failed" }),
        ]);

      const result = await ciCommand(["status"], ctx);

      expect(result).toContain("glab-axi ci log 199507");
    });
  });

  describe("view", () => {
    it("renders the pipeline and its jobs", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline())
        .mockResolvedValueOnce([job(), job({ id: 199507, name: "test" })]);

      const result = await ciCommand(["view", "52377"], ctx);

      expect(apiPathsOf()[0]).toBe("projects/:id/pipelines/52377");
      expect(apiPathsOf()[1]).toBe(
        "projects/:id/pipelines/52377/jobs?per_page=100",
      );
      expect(result).toContain("build");
      expect(result).toContain("test");
    });

    it("requires a pipeline id", async () => {
      await expect(ciCommand(["view"], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("renders a single job with --job", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline())
        .mockResolvedValueOnce([
          job(),
          job({ id: 199507, name: "test", status: "failed" }),
        ]);

      const result = await ciCommand(["view", "52377", "--job", "199507"], ctx);

      expect(result).toContain("test");
      expect(result).not.toContain("199506");
    });

    it("throws when --job is not part of the pipeline", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline())
        .mockResolvedValueOnce([job()]);

      await expect(
        ciCommand(["view", "52377", "--job", "999"], ctx),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Job 999 not found in pipeline 52377",
      });
    });

    it("filters jobs by --status", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline({ status: "failed" }))
        .mockResolvedValueOnce([
          job(),
          job({ id: 199507, name: "test", status: "failed" }),
        ]);

      const result = await ciCommand(
        ["view", "52377", "--status", "failed"],
        ctx,
      );

      expect(result).toContain("jobs: 1 of 2 with status=failed");
      expect(result).toContain("test");
    });
  });

  describe("log", () => {
    it("wraps a job trace in a TOON envelope", async () => {
      mockedText.mockResolvedValue("step 1\nstep 2\ndone\n");

      const result = await ciCommand(["log", "199506"], ctx);

      expect(mockedText).toHaveBeenCalledWith(
        "projects/:id/jobs/199506/trace",
        { ctx },
      );
      expect(result).toContain("job_log:");
      expect(result).toContain("step 1");
      expect(result).toContain("truncated: false");
      expect(result).not.toContain("full_log:");
    });

    it("requires a job id", async () => {
      await expect(ciCommand(["log"], ctx)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    });

    it("strips the runner's ANSI escapes", async () => {
      mockedText.mockResolvedValue(
        "\u001b[0KRunning with gitlab-runner\u001b[0;m\n\u001b[32;1m$ pytest\u001b[0;m\n",
      );

      const result = await ciCommand(["log", "199506"], ctx);

      expect(result).toContain("Running with gitlab-runner");
      expect(result).toContain("$ pytest");
      expect(result).not.toContain("[0;m");
      expect(result).not.toContain("[32;1m");
    });

    it("keeps the tail of an oversized trace and saves the full log", async () => {
      const head = "HEAD-MARKER setup noise\n";
      const tail = "\nERROR: job failed TAIL-MARKER";
      const output = head + "x".repeat(25000) + tail;
      mockedText.mockResolvedValue(output);

      const result = await ciCommand(["log", "199506"], ctx);

      expect(result).toContain("truncated: true");
      expect(result).toContain(`original_length: ${output.length}`);
      expect(result).toContain("TAIL-MARKER");
      expect(result).not.toContain("HEAD-MARKER");

      const fullLogPath = result.match(/^\s*full_log: "?([^"\n]+)"?$/m)?.[1];
      expect(fullLogPath).toBeDefined();
      expect(fullLogPath).toContain(join(tmpdir(), "glab-axi-logs-"));
      expect(fullLogPath).toContain("job-199506.log");
      expect(result).toContain("Output shows the last 20000 of");
      await expect(readFile(fullLogPath!, "utf8")).resolves.toBe(output);
      expect((await stat(dirname(fullLogPath!))).mode & 0o777).toBe(0o700);
      expect((await stat(fullLogPath!)).mode & 0o777).toBe(0o600);
    });
  });

  describe("watch", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns immediately when the pipeline is already finished", async () => {
      mockedApi.mockResolvedValue(pipeline({ status: "success" }));

      const result = await ciCommand(["watch", "52377"], ctx);

      expect(mockedApi).toHaveBeenCalledTimes(1);
      expect(result).toContain("ci_watch:");
      expect(result).toContain("status: success");
    });

    it("polls until the pipeline reaches a final status", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline({ status: "running" }))
        .mockResolvedValueOnce(pipeline({ status: "running" }))
        .mockResolvedValueOnce(pipeline({ status: "failed" }));

      const pending = ciCommand(["watch", "52377", "--interval", "5"], ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(mockedApi).toHaveBeenCalledTimes(3);
      expect(result).toContain("status: failed");
    });

    it("stops on a manual gate instead of polling to the timeout", async () => {
      mockedApi.mockResolvedValue(pipeline({ status: "manual" }));

      const result = await ciCommand(["watch", "52377"], ctx);

      expect(mockedApi).toHaveBeenCalledTimes(1);
      expect(result).toContain("status: manual");
      expect(result).not.toContain("timed_out");
    });

    it("gives up at --timeout without failing", async () => {
      mockedApi.mockResolvedValue(pipeline({ status: "running" }));

      const pending = ciCommand(
        ["watch", "52377", "--interval", "5", "--timeout", "10"],
        ctx,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;

      expect(result).toContain("timed_out: true");
      expect(result).toContain("status: running");
    });
  });

  describe("run", () => {
    it("triggers a pipeline and reports its id", async () => {
      mockedExec.mockResolvedValue(
        "Created pipeline (id: 52378), status: created, ref: main, weburl: https://gitlab.example.com/group/sub/project/-/pipelines/52378\n",
      );

      const result = await ciCommand(
        ["run", "--ref", "main", "--variable", "KEY:value"],
        ctx,
      );

      expect(mockedExec).toHaveBeenCalledWith(
        ["ci", "run", "--branch", "main", "--variables", "KEY:value"],
        ctx,
      );
      expect(result).toContain("52378");
    });

    it("collects every --variable occurrence", async () => {
      mockedExec.mockResolvedValue("");

      await ciCommand(["run", "--variable", "A:1", "--variable", "B:2"], ctx);

      expect(mockedExec.mock.calls[0][0]).toEqual([
        "ci",
        "run",
        "--variables",
        "A:1",
        "--variables",
        "B:2",
      ]);
    });
  });

  describe("retry", () => {
    it("retries a whole pipeline through the API", async () => {
      mockedApi.mockResolvedValue(pipeline({ status: "pending" }));

      const result = await ciCommand(["retry", "52377"], ctx);

      expect(mockedApi).toHaveBeenCalledWith(
        "projects/:id/pipelines/52377/retry",
        { ctx, method: "POST" },
      );
      expect(result).toContain("retry: ok");
      expect(mockedExec).not.toHaveBeenCalled();
    });

    it("retries a single job with --job", async () => {
      mockedApi.mockResolvedValue(job({ status: "pending" }));

      const result = await ciCommand(["retry", "--job", "199507"], ctx);

      expect(mockedApi).toHaveBeenCalledWith("projects/:id/jobs/199507/retry", {
        ctx,
        method: "POST",
      });
      expect(result).toContain("199507");
    });
  });

  describe("cancel", () => {
    it("cancels a running pipeline", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline({ status: "running" }))
        .mockResolvedValueOnce(pipeline({ status: "canceled" }));

      const result = await ciCommand(["cancel", "52377"], ctx);

      expect(apiPathsOf()[1]).toBe("projects/:id/pipelines/52377/cancel");
      expect(result).toContain("cancel: ok");
    });

    it("still cancels a pipeline parked on a manual gate", async () => {
      mockedApi
        .mockResolvedValueOnce(pipeline({ status: "manual" }))
        .mockResolvedValueOnce(pipeline({ status: "canceled" }));

      const result = await ciCommand(["cancel", "52377"], ctx);

      expect(apiPathsOf()[1]).toBe("projects/:id/pipelines/52377/cancel");
      expect(result).toContain("cancel: ok");
    });

    it("is idempotent on an already finished pipeline", async () => {
      mockedApi.mockResolvedValue(pipeline({ status: "success" }));

      const result = await ciCommand(["cancel", "52377"], ctx);

      expect(mockedApi).toHaveBeenCalledTimes(1);
      expect(result).toContain("cancel: already_finished");
    });
  });
});
