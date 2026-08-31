import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabExec } from "../glab.js";
import { AxiError } from "../errors.js";
import { takeFlag, takeNumber, rejectUnknownFlags } from "../args.js";
import {
  field,
  pluck,
  boolYesNo,
  custom,
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

interface ScheduleVariable {
  key?: string;
  value?: string;
}

interface PipelineSchedule {
  id: number;
  description?: string;
  cron?: string;
  cron_timezone?: string;
  ref?: string;
  active?: boolean;
  next_run_at?: string;
  variables?: ScheduleVariable[];
  last_pipeline?: { id: number; status?: string } | null;
}

/** GitLab caps pagination at 100 items per request. */
const PER_PAGE_MAX = 100;

function schedulePath(id: number, suffix = ""): string {
  return `projects/:id/pipeline_schedules/${id}${suffix}`;
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

const listSchema: FieldDef[] = [
  field("id"),
  field("description"),
  field("cron"),
  field("cron_timezone", "timezone"),
  field("ref"),
  boolYesNo("active"),
  relativeTime("next_run_at", "next_run"),
  pluck("owner", "username", "owner"),
];

const viewSchema: FieldDef[] = [
  ...listSchema,
  custom("variables", (item: PipelineSchedule) =>
    (item.variables ?? []).map((variable) => ({
      key: variable.key ?? "",
      value: variable.value ?? "",
    })),
  ),
  custom("last_pipeline", (item: PipelineSchedule) =>
    item.last_pipeline
      ? `${item.last_pipeline.status ?? "unknown"} — pipeline ${item.last_pipeline.id}`
      : "never run",
  ),
];

const SCHEDULE_FLAGS: Record<string, readonly string[]> = {
  list: ["--limit", "--scope"],
  view: [],
  run: [],
  enable: [],
  disable: [],
};

export const SCHEDULE_HELP = `usage: glab-axi schedule <subcommand> [flags]
subcommands[5]:
  list, view <id>, run <id>, enable <id>, disable <id>
note:
  a schedule is a cron entry that starts a pipeline; \`run\` plays it immediately without touching its next run
flags{list}:
  --scope <active|inactive>, --limit <n> (default 30, max 100)
examples:
  glab-axi schedule list
  glab-axi schedule view 13
  glab-axi schedule run 13
  glab-axi schedule disable 13`;

async function fetchSchedule(
  id: number,
  ctx?: RepoContext,
): Promise<PipelineSchedule> {
  return glabApiJson<PipelineSchedule>(schedulePath(id), { ctx });
}

async function scheduleList(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const limit = resolveLimit(args, 30);
  const scope = takeFlag(args, "--scope");

  const query = new URLSearchParams({ per_page: String(limit) });
  if (scope) query.set("scope", scope);

  const schedules = await glabApiJson<PipelineSchedule[]>(
    `projects/:id/pipeline_schedules?${query.toString()}`,
    { ctx },
  );

  return renderOutput([
    formatCountLine({ count: schedules.length, limit }),
    renderList("schedules", schedules, listSchema),
    renderHelp(
      getSuggestions({
        domain: "schedule",
        action: "list",
        isEmpty: schedules.length === 0,
        repo: ctx,
      }),
    ),
  ]);
}

async function scheduleView(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const id = takeNumber(args, "schedule");
  const schedule = await fetchSchedule(id, ctx);
  return renderOutput([renderDetail("schedule", schedule, viewSchema)]);
}

async function scheduleRun(args: string[], ctx?: RepoContext): Promise<string> {
  const id = takeNumber(args, "schedule");
  await glabExec(["schedule", "run", String(id)], ctx);
  return renderOutput([
    encode({ triggered: "ok", schedule: id }),
    renderHelp(
      getSuggestions({ domain: "schedule", action: "run", id, repo: ctx }),
    ),
  ]);
}

/** enable and disable differ only by the `active` value they converge on. */
async function setActive(
  args: string[],
  active: boolean,
  ctx?: RepoContext,
): Promise<string> {
  const id = takeNumber(args, "schedule");
  const action = active ? "enable" : "disable";
  const suggestions = () =>
    renderHelp(getSuggestions({ domain: "schedule", action, id, repo: ctx }));

  const schedule = await fetchSchedule(id, ctx);
  if (schedule.active === active) {
    return renderOutput([
      encode({
        [action]: `already_${active ? "enabled" : "disabled"}`,
        schedule: id,
      }),
      suggestions(),
    ]);
  }

  await glabExec(["schedule", "update", String(id), `--active=${active}`], ctx);
  return renderOutput([
    encode({ [action]: "ok", schedule: id }),
    suggestions(),
  ]);
}

const HANDLERS: Record<
  string,
  (args: string[], ctx?: RepoContext) => Promise<string>
> = {
  list: scheduleList,
  view: scheduleView,
  run: scheduleRun,
  enable: (args, ctx) => setActive(args, true, ctx),
  disable: (args, ctx) => setActive(args, false, ctx),
};

export async function scheduleCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return SCHEDULE_HELP;
  }

  const handler = HANDLERS[sub];
  if (!handler) {
    return renderError(
      `Unknown schedule subcommand: ${sub}`,
      "VALIDATION_ERROR",
      ["Run `glab-axi schedule --help` to see available subcommands"],
    );
  }

  rejectUnknownFlags(rest, SCHEDULE_FLAGS[sub], "schedule", sub);
  return handler(rest, ctx);
}
