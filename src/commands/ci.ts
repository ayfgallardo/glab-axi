import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import { resolveCurrentBranch, type RepoContext } from "../context.js";
import { glabApiJson, glabApiText, glabExec } from "../glab.js";
import { isCancelNoop, isWatchTerminal } from "../pipelineStatus.js";
import { AxiError } from "../errors.js";
import {
  takeFlag,
  takeNumber,
  takeAllFlags,
  pushRepeated,
  rejectUnknownFlags,
} from "../args.js";
import { parseFields, type ExtraFieldSpec } from "../fields.js";
import {
  field,
  pluck,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Pipeline {
  id: number;
  status?: string;
  ref?: string;
  source?: string;
  sha?: string;
  web_url?: string;
}

interface Job {
  id: number;
  name?: string;
  stage?: string;
  status?: string;
  pipeline?: { id: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** GitLab caps pagination at 100 items per request. */
const PER_PAGE_MAX = 100;

const LOG_TRUNCATE_LIMIT = 20000;

/** The trailing `-R` that keeps a suggested command runnable outside this repo. */
function repoArg(ctx?: RepoContext): string {
  return ctx && ctx.source !== "git" ? ` -R ${ctx.fullPath}` : "";
}

/** Clamp a --limit to what GitLab will actually return in one page. */
function resolveLimit(args: string[], fallback: number): number {
  const raw = takeFlag(args, "--limit");
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AxiError(
      "--limit must be a positive integer",
      "VALIDATION_ERROR",
    );
  }
  return Math.min(parsed, PER_PAGE_MAX);
}

function pipelinePath(id: number, suffix = ""): string {
  return `projects/:id/pipelines/${id}${suffix}`;
}

async function fetchPipeline(id: number, ctx?: RepoContext): Promise<Pipeline> {
  return glabApiJson<Pipeline>(pipelinePath(id), { ctx });
}

async function fetchJobs(id: number, ctx?: RepoContext): Promise<Job[]> {
  return glabApiJson<Job[]>(
    pipelinePath(id, `/jobs?per_page=${PER_PAGE_MAX}`),
    { ctx },
  );
}

/** The job list is one page deep, so say so rather than let it read as complete. */
function jobsTruncationNotice(jobs: Job[]): string[] {
  return jobs.length === PER_PAGE_MAX
    ? [`jobs: showing the first ${PER_PAGE_MAX} (the pipeline may have more)`]
    : [];
}

/** Point the agent at the log of every job that failed. */
function failedJobSuggestions(jobs: Job[], ctx?: RepoContext): string[] {
  return jobs
    .filter((job) => job.status === "failed")
    .map(
      (job) =>
        `Run \`glab-axi ci log ${job.id}${repoArg(ctx)}\` to read the log of ${job.name ?? "the failed job"}`,
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("id"),
  lower("status"),
  field("source"),
  field("ref"),
  relativeTime("created_at", "created"),
];

const CI_LIST_EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  sha: { jsonKey: "sha", def: field("sha") },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
  updated_at: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  name: { jsonKey: "name", def: field("name") },
};

const pipelineSchema: FieldDef[] = [
  field("id"),
  lower("status"),
  field("source"),
  field("ref"),
  field("sha"),
  pluck("user", "username", "triggered_by"),
  relativeTime("created_at", "created"),
  field("duration"),
  field("web_url", "url"),
];

const jobSchema: FieldDef[] = [
  field("id"),
  field("name"),
  field("stage"),
  lower("status"),
  field("duration"),
];

const jobDetailSchema: FieldDef[] = [
  ...jobSchema,
  pluck("pipeline", "id", "pipeline"),
  field("ref"),
  field("allow_failure"),
  relativeTime("created_at", "created"),
  field("web_url", "url"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const CI_FLAGS: Record<string, readonly string[]> = {
  list: [
    "--fields",
    "--limit",
    "--status",
    "--ref",
    "--source",
    "--username",
    "--sha",
    "--scope",
  ],
  status: ["--branch"],
  view: ["--job", "--status"],
  log: [],
  watch: ["--interval", "--timeout"],
  run: ["--ref", "--variable"],
  retry: ["--job"],
  cancel: [],
};

export const CI_HELP = `usage: glab-axi ci <subcommand> [flags]
subcommands[8]:
  list, status, view <id>, log <job-id>, watch <id>, run, retry <id>, cancel <id>
note:
  pipelines and jobs are addressed by the id GitLab shows in its UI, not by an iid
flags{list}:
  --status <running|pending|success|failed|canceled|skipped|...>, --ref <branch|tag>, --source <push|merge_request_event|schedule|...>, --username, --sha, --scope <running|pending|finished|branches|tags>, --limit <n> (default 20, max 100), --fields <a,b,c>
flags{status}:
  --branch <name> (default: the branch checked out here, even with -R; outside a checkout, the project's most recent pipeline)
flags{view}:
  --job <job-id> (show a single job), --status <status> (filter the job list)
flags{watch}:
  --interval <seconds> (default 10), --timeout <seconds> (default 600)
flags{run}:
  --ref <branch|tag>, --variable <key:value> (repeatable)
flags{retry}:
  --job <job-id> (retry one job instead of the whole pipeline)
examples:
  glab-axi ci status
  glab-axi ci list --status failed --ref main
  glab-axi ci view 52377
  glab-axi ci log 199507
  glab-axi ci retry 52377`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function ciList(args: string[], ctx?: RepoContext): Promise<string> {
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, CI_LIST_EXTRA_FIELDS);
  const limit = resolveLimit(args, 20);

  const query = new URLSearchParams({ per_page: String(limit) });
  for (const flag of [
    "--status",
    "--ref",
    "--source",
    "--username",
    "--sha",
    "--scope",
  ]) {
    const value = takeFlag(args, flag);
    if (value) query.set(flag.slice(2), value);
  }

  const pipelines = await glabApiJson<Pipeline[]>(
    `projects/:id/pipelines?${query.toString()}`,
    { ctx },
  );

  const extendedSchema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;

  return renderOutput([
    formatCountLine({ count: pipelines.length, limit }),
    renderList("pipelines", pipelines, extendedSchema),
    renderHelp(
      getSuggestions({
        domain: "ci",
        action: "list",
        isEmpty: pipelines.length === 0,
        repo: ctx,
      }),
    ),
  ]);
}

async function ciStatus(args: string[], ctx?: RepoContext): Promise<string> {
  // An agent asking for "the pipeline" means the one for the branch it is on;
  // outside a checkout there is none to name, and the query stays unfiltered.
  const branch = takeFlag(args, "--branch") ?? resolveCurrentBranch();

  // The list endpoint answers 200 + [] for a ref with no pipeline, where
  // `pipelines/latest` answers 403 and hides a real permission problem.
  const query = new URLSearchParams({ per_page: "1" });
  if (branch) query.set("ref", branch);
  const [pipeline] = await glabApiJson<Pipeline[]>(
    `projects/:id/pipelines?${query.toString()}`,
    { ctx },
  );

  if (!pipeline) {
    return renderOutput([
      encode({ ci_status: `no pipeline for ${branch ?? "this project"}` }),
      renderHelp([
        `Run \`glab-axi ci list${repoArg(ctx)}\` to see pipelines on other refs`,
      ]),
    ]);
  }

  const jobs = await fetchJobs(pipeline.id, ctx);

  return renderOutput([
    renderDetail("pipeline", pipeline, pipelineSchema),
    ...jobsTruncationNotice(jobs),
    renderList("jobs", jobs, jobSchema),
    renderHelp([
      ...failedJobSuggestions(jobs, ctx),
      ...getSuggestions({
        domain: "ci",
        action: "status",
        id: pipeline.id,
        state: pipeline.status,
        repo: ctx,
      }),
    ]),
  ]);
}

async function ciView(args: string[], ctx?: RepoContext): Promise<string> {
  const jobFlag = takeFlag(args, "--job");
  const statusFilter = takeFlag(args, "--status");
  const id = takeNumber(args, "pipeline");

  if (jobFlag) {
    // Read the job directly: filtering the (one-page) job list would report a
    // job past the 100th as missing from a pipeline that does contain it.
    const job = await glabApiJson<Job>(`projects/:id/jobs/${jobFlag}`, { ctx });
    if (job.pipeline?.id !== id) {
      throw new AxiError(
        `Job ${jobFlag} belongs to pipeline ${job.pipeline?.id ?? "unknown"}, not ${id}`,
        "VALIDATION_ERROR",
      );
    }
    return renderOutput([
      renderDetail("job", job, jobDetailSchema),
      renderHelp(failedJobSuggestions([job], ctx)),
    ]);
  }

  const pipeline = await fetchPipeline(id, ctx);
  const jobs = await fetchJobs(id, ctx);

  const shown = statusFilter
    ? jobs.filter((job) => job.status === statusFilter)
    : jobs;

  const blocks = [
    renderDetail("pipeline", pipeline, pipelineSchema),
    ...jobsTruncationNotice(jobs),
  ];
  if (statusFilter) {
    blocks.push(
      `jobs: ${shown.length} of ${jobs.length} with status=${statusFilter}`,
    );
  }
  blocks.push(renderList("jobs", shown, jobSchema));
  blocks.push(
    renderHelp([
      ...failedJobSuggestions(shown, ctx),
      ...getSuggestions({
        domain: "ci",
        action: "view",
        id,
        state: pipeline.status,
        repo: ctx,
      }),
    ]),
  );
  return renderOutput(blocks);
}

async function saveFullLog(
  jobId: number,
  output: string,
): Promise<string | undefined> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "glab-axi-logs-"));
    const file = join(dir, `job-${jobId}.log`);
    await writeFile(file, output, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return file;
  } catch {
    // Saving the full log is best-effort; the truncated tail is still returned.
    return undefined;
  }
}

/**
 * A raw GitLab trace is the runner's terminal output, colour codes included.
 * gh hands back an already-clean log, so strip them to keep parity — and to
 * stop a third of the truncation budget going to escape sequences.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

async function ciLog(args: string[], ctx?: RepoContext): Promise<string> {
  const jobId = takeNumber(args, "job");
  const raw = await glabApiText(`projects/:id/jobs/${jobId}/trace`, { ctx });
  const output = raw.replace(ANSI_ESCAPE, "");

  const truncated = output.length > LOG_TRUNCATE_LIMIT;
  const jobLog: Record<string, unknown> = {
    job: jobId,
    // A CI failure is at the end of the log, so keep the tail when truncating.
    output: truncated ? output.slice(-LOG_TRUNCATE_LIMIT) : output,
    truncated,
  };
  if (!truncated) {
    return encode({ job_log: jobLog });
  }

  jobLog.original_length = output.length;
  const fullLogPath = await saveFullLog(jobId, output);
  const hint = `Output shows the last ${LOG_TRUNCATE_LIMIT} of ${output.length} chars`;
  if (!fullLogPath) {
    return renderOutput([encode({ job_log: jobLog }), renderHelp([hint])]);
  }
  jobLog.full_log = fullLogPath;
  return renderOutput([
    encode({ job_log: jobLog }),
    renderHelp([
      `${hint}; full log saved to ${fullLogPath} - grep it for earlier context`,
    ]),
  ]);
}

function resolveSeconds(
  args: string[],
  flag: string,
  fallback: number,
): number {
  const raw = takeFlag(args, flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AxiError(
      `${flag} must be a positive number of seconds`,
      "VALIDATION_ERROR",
    );
  }
  return parsed;
}

async function ciWatch(args: string[], ctx?: RepoContext): Promise<string> {
  const intervalMs = resolveSeconds(args, "--interval", 10) * 1000;
  const timeoutMs = resolveSeconds(args, "--timeout", 600) * 1000;
  const id = takeNumber(args, "pipeline");

  let waitedMs = 0;
  let pipeline = await fetchPipeline(id, ctx);
  while (!isWatchTerminal(pipeline.status) && waitedMs < timeoutMs) {
    await sleep(intervalMs);
    waitedMs += intervalMs;
    pipeline = await fetchPipeline(id, ctx);
  }

  const watch: Record<string, unknown> = {
    pipeline: id,
    status: pipeline.status ?? "unknown",
    waited_seconds: waitedMs / 1000,
  };
  if (!isWatchTerminal(pipeline.status)) {
    watch.timed_out = true;
  }

  return renderOutput([
    encode({ ci_watch: watch }),
    renderHelp(
      getSuggestions({
        domain: "ci",
        action: "watch",
        id,
        state: pipeline.status,
        repo: ctx,
      }),
    ),
  ]);
}

async function ciRun(args: string[], ctx?: RepoContext): Promise<string> {
  const ref = takeFlag(args, "--ref");
  const variables = takeAllFlags(args, "--variable");

  const glabArgs = ["ci", "run"];
  if (ref) glabArgs.push("--branch", ref);
  pushRepeated(glabArgs, "--variables", variables);

  const stdout = await glabExec(glabArgs, ctx);
  // glab reports the new pipeline as a URL: https://<host>/<path>/-/pipelines/42
  const urlMatch = stdout.match(/\/-\/pipelines\/(\d+)/);
  const id = urlMatch ? Number(urlMatch[1]) : undefined;

  return renderOutput([
    renderDetail(
      "triggered",
      { pipeline: id ?? null, ref: ref ?? "current branch" },
      [field("pipeline"), field("ref")],
    ),
    renderHelp(getSuggestions({ domain: "ci", action: "run", id, repo: ctx })),
  ]);
}

async function ciRetry(args: string[], ctx?: RepoContext): Promise<string> {
  const jobFlag = takeFlag(args, "--job");

  if (jobFlag) {
    const job = await glabApiJson<Job>(`projects/:id/jobs/${jobFlag}/retry`, {
      ctx,
      method: "POST",
    });
    return renderOutput([
      encode({ retry: "ok", job: jobFlag, status: job.status ?? "unknown" }),
      renderHelp(
        getSuggestions({
          domain: "ci",
          action: "retry",
          id: jobFlag,
          repo: ctx,
        }),
      ),
    ]);
  }

  const id = takeNumber(args, "pipeline");
  const pipeline = await glabApiJson<Pipeline>(pipelinePath(id, "/retry"), {
    ctx,
    method: "POST",
  });
  return renderOutput([
    encode({
      retry: "ok",
      pipeline: id,
      status: pipeline.status ?? "unknown",
    }),
    renderHelp(
      getSuggestions({ domain: "ci", action: "retry", id, repo: ctx }),
    ),
  ]);
}

async function ciCancel(args: string[], ctx?: RepoContext): Promise<string> {
  const id = takeNumber(args, "pipeline");

  const pipeline = await fetchPipeline(id, ctx);
  if (isCancelNoop(pipeline.status)) {
    return renderOutput([
      encode({
        cancel: "already_finished",
        pipeline: id,
        status: pipeline.status ?? "unknown",
      }),
      renderHelp(
        getSuggestions({ domain: "ci", action: "cancel", id, repo: ctx }),
      ),
    ]);
  }

  const canceled = await glabApiJson<Pipeline>(pipelinePath(id, "/cancel"), {
    ctx,
    method: "POST",
  });
  return renderOutput([
    encode({
      cancel: "ok",
      pipeline: id,
      status: canceled.status ?? "unknown",
    }),
    renderHelp(
      getSuggestions({ domain: "ci", action: "cancel", id, repo: ctx }),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const HANDLERS: Record<
  string,
  (args: string[], ctx?: RepoContext) => Promise<string>
> = {
  list: ciList,
  status: ciStatus,
  view: ciView,
  log: ciLog,
  watch: ciWatch,
  run: ciRun,
  retry: ciRetry,
  cancel: ciCancel,
};

export async function ciCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return CI_HELP;
  }

  const handler = HANDLERS[sub];
  if (!handler) {
    return renderError(`Unknown ci subcommand: ${sub}`, "VALIDATION_ERROR", [
      "Run `glab-axi ci --help` to see available subcommands",
    ]);
  }

  rejectUnknownFlags(rest, CI_FLAGS[sub], "ci", sub);
  return handler(rest, ctx);
}
