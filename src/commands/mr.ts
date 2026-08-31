import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabExec } from "../glab.js";
import { AxiError } from "../errors.js";
import { takeBody, truncateBody } from "../body.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import {
  takeFlag,
  takeBoolFlag,
  takeNumber,
  takeAllFlags,
  pushRepeated,
  rejectUnknownFlags,
  resolveLimit,
  PER_PAGE_MAX,
} from "../args.js";
import { parseFields, type ExtraFieldSpec } from "../fields.js";
import {
  field,
  pluck,
  lower,
  boolYesNo,
  relativeTime,
  joinArray,
  custom,
  renderList,
  renderDetail,
  renderHelp,
  renderError,
  renderOutput,
  type FieldDef,
} from "../toon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlabUser {
  username?: string;
}

interface MrPipeline {
  id: number;
  status?: string;
}

interface MrNote {
  id?: number;
  body?: string;
  author?: GlabUser;
  created_at?: string;
  system?: boolean;
}

/** A note anchored to a diff line carries `position`; a plain thread note does not. */
interface MrDiscussionNote extends MrNote {
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
  resolved?: boolean;
}

interface MrDiscussion {
  id: string;
  notes?: MrDiscussionNote[];
}

interface MrApprovals {
  approved?: boolean;
  /** Premium and Ultimate only; absent on Free. */
  approvals_required?: number;
  approvals_left?: number;
  approved_by?: { user?: GlabUser }[];
}

interface MrItem {
  iid: number;
  title: string;
  state: string;
  author?: GlabUser;
  draft?: boolean;
  detailed_merge_status?: string;
  source_branch?: string;
  target_branch?: string;
  merged_at?: string | null;
  merge_user?: GlabUser | null;
  description?: string;
  user_notes_count?: number;
  reviewers?: GlabUser[];
  head_pipeline?: MrPipeline | null;
}

interface PipelineJob {
  name?: string;
  stage?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify a GitLab job status into a simple status category. */
function classifyJob(job: PipelineJob): "pass" | "fail" | "skip" | "pending" {
  switch (job.status) {
    case "success":
      return "pass";
    case "failed":
    case "canceled":
    case "canceling":
      return "fail";
    case "skipped":
    case "manual":
      return "skip";
    default:
      return "pending";
  }
}

function mrPath(iid: number, suffix = ""): string {
  return `projects/:id/merge_requests/${iid}${suffix}`;
}

/** The trailing `-R` that keeps a suggested command runnable outside this repo. */
function repoArg(ctx?: RepoContext): string {
  return ctx && ctx.source !== "git" ? ` -R ${ctx.fullPath}` : "";
}

async function fetchMr(iid: number, ctx?: RepoContext): Promise<MrItem> {
  return glabApiJson<MrItem>(mrPath(iid), { ctx });
}

/** Post a comment on a merge request. `glab mr note create` is still experimental. */
async function postNote(
  iid: number,
  body: string,
  ctx?: RepoContext,
): Promise<void> {
  await glabApiJson<MrNote>(mrPath(iid, "/notes"), {
    ctx,
    method: "POST",
    fields: { body },
  });
}

function summarize(
  counts: Record<"pass" | "fail" | "skip" | "pending", number>,
  total: number,
): string {
  const parts = [`${counts.pass} passed`, `${counts.fail} failed`];
  if (counts.skip > 0) parts.push(`${counts.skip} skipped`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  parts.push(`${total} total`);
  return parts.join(", ");
}

function countJobs(
  jobs: PipelineJob[],
): Record<"pass" | "fail" | "skip" | "pending", number> {
  const counts = { pass: 0, fail: 0, skip: 0, pending: 0 };
  for (const job of jobs) counts[classifyJob(job)]++;
  return counts;
}

async function fetchPipelineJobs(
  pipelineId: number,
  ctx?: RepoContext,
): Promise<PipelineJob[]> {
  return glabApiJson<PipelineJob[]>(
    `projects/:id/pipelines/${pipelineId}/jobs?per_page=${PER_PAGE_MAX}`,
    { ctx },
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  boolYesNo("draft"),
  field("detailed_merge_status", "merge_status"),
];

const MR_LIST_EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  description: { jsonKey: "description", def: field("description") },
  created_at: {
    jsonKey: "created_at",
    def: relativeTime("created_at", "created"),
  },
  labels: { jsonKey: "labels", def: joinArray("labels", "name", "labels") },
  milestone: {
    jsonKey: "milestone",
    def: pluck("milestone", "title", "milestone"),
  },
  merged_at: { jsonKey: "merged_at", def: relativeTime("merged_at") },
  source_branch: { jsonKey: "source_branch", def: field("source_branch") },
  target_branch: { jsonKey: "target_branch", def: field("target_branch") },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
};

const viewSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  boolYesNo("draft"),
  field("source_branch"),
  field("target_branch"),
  field("detailed_merge_status", "merge_status"),
  custom("merged", (item: MrItem) =>
    item.state === "merged" ? (item.merged_at ?? "yes") : "no",
  ),
  custom("pipeline", (item: MrItem) =>
    item.head_pipeline
      ? `${item.head_pipeline.status ?? "unknown"} — pipeline ${item.head_pipeline.id}`
      : "no pipeline for the head commit",
  ),
  joinArray("reviewers", "username", "reviewers"),
  custom("body", (item: MrItem) => truncateBody(item.description, 500)),
];

const viewSchemaFull: FieldDef[] = viewSchema.map((f) =>
  "as" in f && f.as === "body"
    ? custom("body", (item: MrItem) =>
        typeof item.description === "string" ? item.description : "",
      )
    : f,
);

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const MR_FLAGS: Record<string, readonly string[]> = {
  list: [
    "--fields",
    "--state",
    "--label",
    "--assignee",
    "--author",
    "--target-branch",
    "--source-branch",
    "--draft",
    "--search",
    "--limit",
  ],
  view: ["--comments", "--reviews", "--full"],
  create: [
    "--title",
    "--body",
    "--body-file",
    "--target-branch",
    "--source-branch",
    "--draft",
    "--assignee",
    "--reviewer",
    "--label",
    "--milestone",
    "--remove-source-branch",
  ],
  edit: [
    "--title",
    "--body",
    "--body-file",
    "--add-label",
    "--remove-label",
    "--add-assignee",
    "--remove-assignee",
    "--add-reviewer",
    "--remove-reviewer",
    "--milestone",
    "--target-branch",
  ],
  close: [],
  merge: [
    "--method",
    "--merge",
    "--squash",
    "--rebase",
    "--auto",
    "--now",
    "--remove-source-branch",
    "--body",
    "--body-file",
  ],
  review: ["--approve", "--revoke", "--comment", "--body", "--body-file"],
  checks: [],
  diff: ["--full"],
  checkout: [],
  ready: [],
  reopen: [],
  comment: ["--body", "--body-file"],
  rebase: ["--skip-ci"],
};

export const MR_HELP = `usage: glab-axi mr <subcommand> [flags]
subcommands[14]:
  list, view <iid>, create, edit <iid>, close <iid>, merge <iid>, review <iid>, checks <iid>, diff <iid>, checkout <iid>, ready <iid>, reopen <iid>, comment <iid>, rebase <iid>
flags{list}:
  --state <opened|closed|merged|locked|all>, --label (repeatable), --assignee, --author, --target-branch, --source-branch, --draft, --search <text>, --limit <n> (default 30, max 100), --fields <a,b,c>
flags{view}:
  --comments, --reviews (show approvals and diff review threads), --full (show complete description without truncation)
flags{create}:
  --title <text> (required), --body <text> or --body-file <path>, --target-branch, --source-branch, --draft, --assignee <username> (repeatable), --reviewer <username> (repeatable), --label <name> (repeatable), --milestone, --remove-source-branch
notes{create}:
  must run from a checkout of the target project (a matching git remote is required, even with -R)
flags{edit}:
  --title <text>, --body <text> or --body-file <path>, --add-label <name> (repeatable), --remove-label <name> (repeatable), --add-assignee <username> (repeatable), --remove-assignee <username> (repeatable), --add-reviewer <username> (repeatable), --remove-reviewer <username> (repeatable), --milestone, --target-branch
flags{merge}:
  --method <merge|squash|rebase>, --merge, --squash, --rebase, --auto (wait for the running pipeline — already the default), --now (merge immediately instead of waiting), --remove-source-branch, --body <text> or --body-file <path> (merge commit message)
flags{review}:
  --approve, --revoke (remove your approval), --comment, --body <text> or --body-file <path>
flags{comment}:
  --body <text> or --body-file <path> (required)
flags{checks}:
  (none)
flags{diff}:
  --full (show complete diff without truncation)
flags{rebase}:
  --skip-ci
examples:
  glab-axi mr list --state opened --label bug
  glab-axi mr view 42 --comments
  glab-axi mr view 42 --reviews
  glab-axi mr comment 42 --body-file review.md
  glab-axi mr merge 42 --squash --remove-source-branch`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function mrList(args: string[], ctx?: RepoContext): Promise<string> {
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, MR_LIST_EXTRA_FIELDS);
  const state = takeFlag(args, "--state") ?? "opened";
  const labels = takeAllFlags(args, "--label");
  const assignee = takeFlag(args, "--assignee");
  const author = takeFlag(args, "--author");
  const targetBranch = takeFlag(args, "--target-branch");
  const sourceBranch = takeFlag(args, "--source-branch");
  const draft = takeBoolFlag(args, "--draft");
  const search = takeFlag(args, "--search");
  const limit = resolveLimit(args, 30);

  const query = new URLSearchParams({ state, per_page: String(limit) });
  if (labels.length > 0) query.set("labels", labels.join(","));
  if (assignee) query.set("assignee_username", assignee);
  if (author) query.set("author_username", author);
  if (targetBranch) query.set("target_branch", targetBranch);
  if (sourceBranch) query.set("source_branch", sourceBranch);
  if (draft) query.set("draft", "true");
  if (search) query.set("search", search);

  const items = await glabApiJson<MrItem[]>(
    `projects/:id/merge_requests?${query.toString()}`,
    { ctx },
  );

  const countLine = formatCountLine({ count: items.length, limit });
  const extendedSchema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;

  return renderOutput([
    countLine,
    renderList("merge_requests", items, extendedSchema),
    renderHelp(
      getSuggestions({
        domain: "mr",
        action: "list",
        isEmpty: items.length === 0,
        repo: ctx,
      }),
    ),
  ]);
}

async function mrView(args: string[], ctx?: RepoContext): Promise<string> {
  const includeComments = takeBoolFlag(args, "--comments");
  const includeReviews = takeBoolFlag(args, "--reviews");
  const full = takeBoolFlag(args, "--full");
  const iid = takeNumber(args, "MR");

  const mr = await fetchMr(iid, ctx);
  const schema = [...(full ? viewSchemaFull : viewSchema)];

  if (includeComments) {
    const notes = await glabApiJson<MrNote[]>(
      mrPath(iid, `/notes?per_page=${PER_PAGE_MAX}`),
      { ctx },
    );
    const userNotes = notes.filter((note) => !note.system);
    schema.push(
      custom("comments", () =>
        userNotes.map((note) => ({
          author: note.author?.username ?? "unknown",
          body: note.body ?? "",
          created: note.created_at ?? "",
        })),
      ),
    );
  } else {
    schema.push(
      custom(
        "comment_count",
        (item: MrItem) =>
          `${item.user_notes_count ?? 0} — use --comments to see full comments`,
      ),
    );
  }

  if (includeReviews) {
    const approvals = await glabApiJson<MrApprovals>(
      mrPath(iid, "/approvals"),
      { ctx },
    );
    const discussions = await glabApiJson<MrDiscussion[]>(
      mrPath(iid, `/discussions?per_page=${PER_PAGE_MAX}`),
      { ctx },
    );
    schema.push(
      custom("approvals", () => ({
        approved: approvals.approved ? "yes" : "no",
        required: approvals.approvals_required ?? null,
        left: approvals.approvals_left ?? null,
        approved_by:
          (approvals.approved_by ?? [])
            .map((entry) => entry.user?.username ?? "unknown")
            .join(",") || "none",
      })),
      custom("review_threads", () =>
        discussions
          .map((discussion) => (discussion.notes ?? [])[0])
          .filter((note): note is MrDiscussionNote => !!note && !!note.position)
          .map((note) => ({
            author: note.author?.username ?? "unknown",
            path: note.position?.new_path ?? note.position?.old_path ?? "",
            line: note.position?.new_line ?? note.position?.old_line ?? null,
            resolved: note.resolved ? "yes" : "no",
            body: note.body ?? "",
          })),
      ),
    );
  } else {
    schema.push(
      custom(
        "review_summary",
        () => "use --reviews to see approvals and diff review threads",
      ),
    );
  }

  return renderOutput([renderDetail("merge_request", mr, schema)]);
}

async function mrCreate(args: string[], ctx?: RepoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const body = takeBody(args);
  const targetBranch = takeFlag(args, "--target-branch");
  const sourceBranch = takeFlag(args, "--source-branch");
  const draft = takeBoolFlag(args, "--draft");
  const removeSourceBranch = takeBoolFlag(args, "--remove-source-branch");
  const assignees = takeAllFlags(args, "--assignee");
  const reviewers = takeAllFlags(args, "--reviewer");
  const labels = takeAllFlags(args, "--label");
  const milestone = takeFlag(args, "--milestone");

  // --description is always passed: glab otherwise falls back to an editor or a
  // prompt, and --yes only skips the final submission confirmation.
  const glabArgs = [
    "mr",
    "create",
    "--title",
    title,
    "--description",
    body ?? "",
    "--yes",
  ];
  if (targetBranch) glabArgs.push("--target-branch", targetBranch);
  if (sourceBranch) glabArgs.push("--source-branch", sourceBranch);
  if (draft) glabArgs.push("--draft");
  if (removeSourceBranch) glabArgs.push("--remove-source-branch");
  pushRepeated(glabArgs, "--assignee", assignees);
  pushRepeated(glabArgs, "--reviewer", reviewers);
  pushRepeated(glabArgs, "--label", labels);
  if (milestone) glabArgs.push("--milestone", milestone);

  const stdout = await glabExec(glabArgs, ctx);
  // Parse the iid from the emitted URL: https://<host>/<path>/-/merge_requests/42
  const urlMatch = stdout.match(/\/-\/merge_requests\/(\d+)/);
  const iid = urlMatch ? Number(urlMatch[1]) : undefined;
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";

  return renderOutput([
    renderDetail("created", { iid: iid ?? null, url }, [
      field("iid"),
      field("url"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "create", id: iid, repo: ctx }),
    ),
  ]);
}

/** glab mr update replaces assignees/reviewers unless each name carries a +/! prefix. */
function pushPrefixed(
  glabArgs: string[],
  flag: string,
  values: string[],
  prefix: string,
): void {
  for (const value of values) glabArgs.push(flag, `${prefix}${value}`);
}

async function mrEdit(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const addLabels = takeAllFlags(args, "--add-label");
  const removeLabels = takeAllFlags(args, "--remove-label");
  const addAssignees = takeAllFlags(args, "--add-assignee");
  const removeAssignees = takeAllFlags(args, "--remove-assignee");
  const addReviewers = takeAllFlags(args, "--add-reviewer");
  const removeReviewers = takeAllFlags(args, "--remove-reviewer");
  const milestone = takeFlag(args, "--milestone");
  const targetBranch = takeFlag(args, "--target-branch");

  const glabArgs = ["mr", "update", String(iid), "--yes"];
  if (title) glabArgs.push("--title", title);
  if (body !== undefined) glabArgs.push("--description", body);
  pushRepeated(glabArgs, "--label", addLabels);
  pushRepeated(glabArgs, "--unlabel", removeLabels);
  pushPrefixed(glabArgs, "--assignee", addAssignees, "+");
  pushPrefixed(glabArgs, "--assignee", removeAssignees, "!");
  pushPrefixed(glabArgs, "--reviewer", addReviewers, "+");
  pushPrefixed(glabArgs, "--reviewer", removeReviewers, "!");
  if (milestone) glabArgs.push("--milestone", milestone);
  if (targetBranch) glabArgs.push("--target-branch", targetBranch);

  await glabExec(glabArgs, ctx);
  return renderOutput([
    renderDetail("edited", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "edit", id: iid, repo: ctx }),
    ),
  ]);
}

function alreadyBlock(
  iid: number,
  action: string,
  state: string,
  ctx?: RepoContext,
): string {
  return renderOutput([
    renderDetail("merge_request", { iid, state, already: true }, [
      field("iid"),
      field("state"),
      field("already"),
    ]),
    renderHelp(getSuggestions({ domain: "mr", action, id: iid, repo: ctx })),
  ]);
}

async function mrClose(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");

  const mr = await fetchMr(iid, ctx);
  if (mr.state === "closed" || mr.state === "merged") {
    return alreadyBlock(iid, "close", mr.state, ctx);
  }

  await glabExec(["mr", "close", String(iid)], ctx);
  return renderOutput([
    renderDetail("closed", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "close", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrReopen(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");

  const mr = await fetchMr(iid, ctx);
  if (mr.state === "opened") {
    return alreadyBlock(iid, "reopen", "opened", ctx);
  }

  await glabExec(["mr", "reopen", String(iid)], ctx);
  return renderOutput([
    renderDetail("reopened", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "reopen", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrReady(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");

  const mr = await fetchMr(iid, ctx);
  if (!mr.draft) {
    return renderOutput([
      renderDetail("merge_request", { iid, draft: "no", already: true }, [
        field("iid"),
        field("draft"),
        field("already"),
      ]),
      renderHelp(
        getSuggestions({ domain: "mr", action: "ready", id: iid, repo: ctx }),
      ),
    ]);
  }

  await glabExec(["mr", "update", String(iid), "--ready", "--yes"], ctx);
  return renderOutput([
    renderDetail("ready", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "ready", id: iid, repo: ctx }),
    ),
  ]);
}

const MERGE_METHODS = ["merge", "squash", "rebase"];

async function mrMerge(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  const explicitMethod = takeFlag(args, "--method");
  const shorthandMethods = MERGE_METHODS.filter((candidate) =>
    takeBoolFlag(args, `--${candidate}`),
  );
  if (shorthandMethods.length > 1) {
    throw new AxiError(
      "Choose only one merge method: --merge, --squash, or --rebase",
      "VALIDATION_ERROR",
    );
  }
  if (
    explicitMethod &&
    shorthandMethods.length === 1 &&
    explicitMethod !== shorthandMethods[0]
  ) {
    throw new AxiError(
      "Choose either --method or a matching merge method shorthand, not both",
      "VALIDATION_ERROR",
    );
  }
  const method = explicitMethod ?? shorthandMethods[0];
  if (method && !MERGE_METHODS.includes(method)) {
    throw new AxiError(
      "--method must be one of: merge, squash, rebase",
      "VALIDATION_ERROR",
    );
  }
  const auto = takeBoolFlag(args, "--auto");
  const now = takeBoolFlag(args, "--now");
  if (auto && now) {
    throw new AxiError(
      "Choose either --auto or --now, not both",
      "VALIDATION_ERROR",
    );
  }
  const removeSourceBranch = takeBoolFlag(args, "--remove-source-branch");
  const body = takeBody(args);

  const mr = await fetchMr(iid, ctx);
  if (mr.state === "merged") {
    return renderOutput([
      renderDetail(
        "merge_request",
        {
          iid,
          state: "merged",
          merged_by: mr.merge_user?.username ?? null,
          merged_at: mr.merged_at ?? null,
        },
        [field("iid"), field("state"), field("merged_by"), field("merged_at")],
      ),
      renderHelp(
        getSuggestions({ domain: "mr", action: "merge", id: iid, repo: ctx }),
      ),
    ]);
  }

  const glabArgs = ["mr", "merge", String(iid), "--yes"];
  // A merge commit is glab's default, so only squash and rebase need a flag.
  if (method === "squash") glabArgs.push("--squash");
  if (method === "rebase") glabArgs.push("--rebase");
  // glab defaults --auto-merge to true whenever a pipeline is running, so the
  // value is always spelled out: otherwise `--auto` is a no-op and there is no
  // way to ask for an immediate merge at all.
  glabArgs.push(`--auto-merge=${now ? "false" : "true"}`);
  if (removeSourceBranch) glabArgs.push("--remove-source-branch");
  if (body !== undefined) glabArgs.push("--message", body);

  await glabExec(glabArgs, ctx);

  return renderOutput([
    renderDetail(
      "merged",
      {
        iid,
        status: "ok",
        method: method ?? "merge",
        auto_merge: now ? "no" : "yes",
      },
      [field("iid"), field("status"), field("method"), field("auto_merge")],
    ),
    renderHelp(
      getSuggestions({ domain: "mr", action: "merge", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrReview(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  const approve = takeBoolFlag(args, "--approve");
  const revoke = takeBoolFlag(args, "--revoke");
  takeBoolFlag(args, "--comment");
  if (approve && revoke) {
    throw new AxiError(
      "Choose either --approve or --revoke, not both",
      "VALIDATION_ERROR",
    );
  }
  // Without an approval verdict a review is only its comment, so the body is
  // then the whole payload and must be present.
  const body =
    !approve && !revoke
      ? takeBody(args, { required: true, label: "review comment" })
      : takeBody(args);

  if (approve) await glabExec(["mr", "approve", String(iid)], ctx);
  if (revoke) await glabExec(["mr", "revoke", String(iid)], ctx);
  if (body !== undefined) await postNote(iid, body, ctx);

  const action = approve ? "approved" : revoke ? "revoked" : "commented";
  return renderOutput([
    renderDetail("review", { iid, action }, [field("iid"), field("action")]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "review", id: iid, repo: ctx }),
    ),
  ]);
}

const checksSchema: FieldDef[] = [
  custom("name", (job: PipelineJob) => job.name ?? "job"),
  field("stage"),
  field("status"),
];

async function mrChecks(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");

  const mr = await fetchMr(iid, ctx);
  const pipeline = mr.head_pipeline;
  if (!pipeline) {
    return renderOutput([
      encode({
        checks: "no pipeline ran for the head commit of this merge request",
      }),
    ]);
  }

  const jobs = await fetchPipelineJobs(pipeline.id, ctx);
  const counts = countJobs(jobs);

  const suggestions = getSuggestions({
    domain: "mr",
    action: "checks",
    id: iid,
    repo: ctx,
  });
  if (counts.fail > 0) {
    suggestions.unshift(
      `Run \`glab-axi ci view ${pipeline.id}${repoArg(ctx)}\` to inspect the failing pipeline`,
    );
  }

  return renderOutput([
    encode({
      pipeline: pipeline.id,
      status: pipeline.status ?? "unknown",
      summary: summarize(counts, jobs.length),
    }),
    renderList("checks", jobs, checksSchema),
    renderHelp(suggestions),
  ]);
}

const DIFF_TRUNCATE_LIMIT = 4000;

async function mrDiff(args: string[], ctx?: RepoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const iid = takeNumber(args, "MR");
  const diff = await glabExec(["mr", "diff", String(iid), "--raw"], ctx);

  const shouldTruncate = !full && diff.length > DIFF_TRUNCATE_LIMIT;
  const diffBlock: Record<string, unknown> = {
    iid,
    diff: shouldTruncate ? diff.slice(0, DIFF_TRUNCATE_LIMIT) : diff,
  };
  if (shouldTruncate) {
    diffBlock.truncated = true;
    diffBlock.original_length = diff.length;
  }

  const suggestions = getSuggestions({
    domain: "mr",
    action: "diff",
    id: iid,
    repo: ctx,
  });
  if (shouldTruncate) {
    suggestions.unshift(
      `Run \`glab-axi mr diff ${iid} --full${repoArg(ctx)}\` to see the complete diff`,
    );
  }

  return renderOutput([
    encode({ mr_diff: diffBlock }),
    renderHelp(suggestions),
  ]);
}

async function mrCheckout(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  // glab writes the branch name to stderr through git, so read it from the API.
  const mr = await fetchMr(iid, ctx);
  await glabExec(["mr", "checkout", String(iid)], ctx);

  return renderOutput([
    renderDetail(
      "checkout",
      { iid, branch: mr.source_branch ?? "", status: "ok" },
      [field("iid"), field("branch"), field("status")],
    ),
    renderHelp(
      getSuggestions({ domain: "mr", action: "checkout", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrComment(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  const body = takeBody(args, { required: true });

  await postNote(iid, body, ctx);
  return renderOutput([
    renderDetail("commented", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "comment", id: iid, repo: ctx }),
    ),
  ]);
}

async function mrRebase(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "MR");
  const skipCi = takeBoolFlag(args, "--skip-ci");

  const glabArgs = ["mr", "rebase", String(iid)];
  if (skipCi) glabArgs.push("--skip-ci");
  await glabExec(glabArgs, ctx);

  return renderOutput([
    renderDetail("rebased", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "mr", action: "rebase", id: iid, repo: ctx }),
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
  list: mrList,
  view: mrView,
  create: mrCreate,
  edit: mrEdit,
  close: mrClose,
  merge: mrMerge,
  review: mrReview,
  checks: mrChecks,
  diff: mrDiff,
  checkout: mrCheckout,
  ready: mrReady,
  reopen: mrReopen,
  comment: mrComment,
  rebase: mrRebase,
};

export async function mrCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return MR_HELP;
  }

  const handler = HANDLERS[sub];
  if (!handler) {
    return renderError(`Unknown mr subcommand: ${sub}`, "VALIDATION_ERROR", [
      "Run `glab-axi mr --help` to see available subcommands",
    ]);
  }

  rejectUnknownFlags(rest, MR_FLAGS[sub], "mr", sub);
  return handler(rest, ctx);
}
