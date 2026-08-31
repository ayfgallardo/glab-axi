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

interface IssueLabel {
  name?: string;
}

interface IssueItem {
  iid: number;
  title: string;
  state: string;
  author?: GlabUser;
  description?: string;
  labels?: (string | IssueLabel)[];
  assignees?: GlabUser[];
  milestone?: { title?: string } | null;
  created_at?: string;
  user_notes_count?: number;
  discussion_locked?: boolean;
  web_url?: string;
}

interface IssueNote {
  id?: number;
  body?: string;
  author?: GlabUser;
  created_at?: string;
  system?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issuePath(iid: number, suffix = ""): string {
  return `projects/:id/issues/${iid}${suffix}`;
}

async function fetchIssue(iid: number, ctx?: RepoContext): Promise<IssueItem> {
  return glabApiJson<IssueItem>(issuePath(iid), { ctx });
}

async function postNote(
  iid: number,
  body: string,
  ctx?: RepoContext,
): Promise<IssueNote> {
  return glabApiJson<IssueNote>(issuePath(iid, "/notes"), {
    ctx,
    method: "POST",
    fields: { body },
  });
}

/** glab issue update replaces assignees unless each name carries a +/! prefix. */
function pushPrefixed(
  glabArgs: string[],
  flag: string,
  values: string[],
  prefix: string,
): void {
  for (const value of values) glabArgs.push(flag, `${prefix}${value}`);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  relativeTime("created_at", "created"),
];

const ISSUE_LIST_EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  description: { jsonKey: "description", def: field("description") },
  labels: { jsonKey: "labels", def: joinArray("labels", "name", "labels") },
  assignees: {
    jsonKey: "assignees",
    def: joinArray("assignees", "username", "assignees"),
  },
  milestone: {
    jsonKey: "milestone",
    def: pluck("milestone", "title", "milestone"),
  },
  url: { jsonKey: "web_url", def: field("web_url", "url") },
};

const viewSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  pluck("author", "username", "author"),
  relativeTime("created_at", "created"),
  joinArray("labels", "name", "labels"),
  joinArray("assignees", "username", "assignees"),
  pluck("milestone", "title", "milestone"),
  custom("body", (item: IssueItem) => truncateBody(item.description, 500)),
];

const viewSchemaFull: FieldDef[] = viewSchema.map((f) =>
  "as" in f && f.as === "body"
    ? custom("body", (item: IssueItem) =>
        typeof item.description === "string" ? item.description : "",
      )
    : f,
);

const editResultSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  lower("state"),
  joinArray("labels", "name", "labels"),
  joinArray("assignees", "username", "assignees"),
];

const commentResultSchema: FieldDef[] = [
  field("iid"),
  pluck("author", "username", "author"),
  relativeTime("created_at", "created"),
  custom("body", (item: IssueNote) => truncateBody(item.body, 800)),
];

const lockResultSchema: FieldDef[] = [
  field("iid"),
  lower("state"),
  boolYesNo("discussion_locked", "locked"),
];

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const ISSUE_FLAGS: Record<string, readonly string[]> = {
  list: [
    "--fields",
    "--state",
    "--label",
    "--assignee",
    "--author",
    "--milestone",
    "--search",
    "--limit",
  ],
  view: ["--comments", "--full"],
  create: [
    "--title",
    "--body",
    "--body-file",
    "--assignee",
    "--label",
    "--milestone",
  ],
  edit: [
    "--title",
    "--body",
    "--body-file",
    "--add-label",
    "--remove-label",
    "--add-assignee",
    "--remove-assignee",
    "--milestone",
  ],
  close: [],
  reopen: [],
  comment: ["--body", "--body-file"],
  delete: [],
  lock: [],
  unlock: [],
};

export const ISSUE_HELP = `usage: glab-axi issue <subcommand> [flags]
subcommands[10]:
  list, view <iid>, create, edit <iid>, close <iid>, reopen <iid>, comment <iid>, delete <iid>, lock <iid>, unlock <iid>
flags{list}:
  --state <opened|closed>, --label (repeatable), --assignee, --author, --milestone, --search <text>, --limit <n> (default 30, max 100), --fields <a,b,c>
flags{view}:
  --comments, --full (show the complete description and comment bodies without truncation)
flags{create}:
  --title <text> (required), --body <text> or --body-file <path>, --assignee <username> (repeatable), --label <name> (repeatable), --milestone
flags{edit}:
  --title, --body <text> or --body-file <path>, --add-label <name> (repeatable), --remove-label <name> (repeatable), --add-assignee <username> (repeatable), --remove-assignee <username> (repeatable), --milestone
flags{comment}:
  --body <text> or --body-file <path> (required)
examples:
  glab-axi issue list --state closed --label bug
  glab-axi issue view 42 --comments
  glab-axi issue create --title "Fix login" --body-file report.md
  glab-axi issue comment 42 --body-file comment.md
  glab-axi issue close 42
  glab-axi issue lock 42`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function issueList(args: string[], ctx?: RepoContext): Promise<string> {
  const fieldsArg = takeFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, ISSUE_LIST_EXTRA_FIELDS);
  const state = takeFlag(args, "--state") ?? "opened";
  const labels = takeAllFlags(args, "--label");
  const assignee = takeFlag(args, "--assignee");
  const author = takeFlag(args, "--author");
  const milestone = takeFlag(args, "--milestone");
  const search = takeFlag(args, "--search");
  const limit = resolveLimit(args, 30);

  const query = new URLSearchParams({ state, per_page: String(limit) });
  if (labels.length > 0) query.set("labels", labels.join(","));
  if (assignee) query.set("assignee_username", assignee);
  if (author) query.set("author_username", author);
  if (milestone) query.set("milestone", milestone);
  if (search) query.set("search", search);

  const items = await glabApiJson<IssueItem[]>(
    `projects/:id/issues?${query.toString()}`,
    { ctx },
  );

  const countLine = formatCountLine({ count: items.length, limit });
  const extendedSchema =
    extraDefs.length > 0 ? [...listSchema, ...extraDefs] : listSchema;

  return renderOutput([
    countLine,
    renderList("issues", items, extendedSchema),
    renderHelp(
      getSuggestions({
        domain: "issue",
        action: "list",
        isEmpty: items.length === 0,
        repo: ctx,
      }),
    ),
  ]);
}

async function issueView(args: string[], ctx?: RepoContext): Promise<string> {
  const includeComments = takeBoolFlag(args, "--comments");
  const full = takeBoolFlag(args, "--full");
  const iid = takeNumber(args, "issue");

  const issue = await fetchIssue(iid, ctx);
  const schema = [...(full ? viewSchemaFull : viewSchema)];

  if (includeComments) {
    const notes = await glabApiJson<IssueNote[]>(
      issuePath(iid, `/notes?per_page=${PER_PAGE_MAX}`),
      { ctx },
    );
    const userNotes = notes.filter((note) => !note.system);
    schema.push(
      custom("comments", () =>
        userNotes.map((note) => ({
          author: note.author?.username ?? "unknown",
          body: full ? (note.body ?? "") : truncateBody(note.body, 800),
          created: note.created_at ?? "",
        })),
      ),
    );
  } else {
    schema.push(
      custom(
        "comment_count",
        (item: IssueItem) =>
          `${item.user_notes_count ?? 0} — use --comments to see full comments`,
      ),
    );
  }

  return renderOutput([renderDetail("issue", issue, schema)]);
}

async function issueCreate(args: string[], ctx?: RepoContext): Promise<string> {
  const title = takeFlag(args, "--title");
  if (!title) throw new AxiError("--title is required", "VALIDATION_ERROR");
  const body = takeBody(args);
  const assignees = takeAllFlags(args, "--assignee");
  const labels = takeAllFlags(args, "--label");
  const milestone = takeFlag(args, "--milestone");

  // --description is always passed: glab otherwise falls back to an editor or
  // a prompt, and --yes only skips the final submission confirmation.
  const glabArgs = [
    "issue",
    "create",
    "--title",
    title,
    "--description",
    body ?? "",
    "--yes",
  ];
  pushRepeated(glabArgs, "--assignee", assignees);
  pushRepeated(glabArgs, "--label", labels);
  if (milestone) glabArgs.push("--milestone", milestone);

  const stdout = await glabExec(glabArgs, ctx);
  // Parse the iid from the emitted URL: https://<host>/<path>/-/issues/42
  const urlMatch = stdout.match(/\/-\/issues\/(\d+)/);
  const iid = urlMatch ? Number(urlMatch[1]) : undefined;
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";

  return renderOutput([
    renderDetail("created", { iid: iid ?? url, url }, [
      field("iid"),
      field("url"),
    ]),
    renderHelp(
      getSuggestions({ domain: "issue", action: "create", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueEdit(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");
  const title = takeFlag(args, "--title");
  const body = takeBody(args);
  const addLabels = takeAllFlags(args, "--add-label");
  const removeLabels = takeAllFlags(args, "--remove-label");
  const addAssignees = takeAllFlags(args, "--add-assignee");
  const removeAssignees = takeAllFlags(args, "--remove-assignee");
  const milestone = takeFlag(args, "--milestone");

  const glabArgs = ["issue", "update", String(iid)];
  if (title) glabArgs.push("--title", title);
  if (body !== undefined) glabArgs.push("--description", body);
  pushRepeated(glabArgs, "--label", addLabels);
  pushRepeated(glabArgs, "--unlabel", removeLabels);
  pushPrefixed(glabArgs, "--assignee", addAssignees, "+");
  pushPrefixed(glabArgs, "--assignee", removeAssignees, "!");
  if (milestone) glabArgs.push("--milestone", milestone);

  // Only call `glab issue update` when a field beyond the issue number changed.
  if (glabArgs.length > 3) {
    await glabExec(glabArgs, ctx);
  }

  const item = await fetchIssue(iid, ctx);
  return renderOutput([
    renderDetail("issue", item, editResultSchema),
    renderHelp(
      getSuggestions({ domain: "issue", action: "edit", id: iid, repo: ctx }),
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
    renderDetail("issue", { iid, state, already: true }, [
      field("iid"),
      field("state"),
      field("already"),
    ]),
    renderHelp(getSuggestions({ domain: "issue", action, id: iid, repo: ctx })),
  ]);
}

async function issueClose(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");

  const issue = await fetchIssue(iid, ctx);
  if (issue.state === "closed") {
    return alreadyBlock(iid, "close", "closed", ctx);
  }

  await glabExec(["issue", "close", String(iid)], ctx);
  return renderOutput([
    renderDetail("closed", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "issue", action: "close", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueReopen(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");

  const issue = await fetchIssue(iid, ctx);
  if (issue.state === "opened") {
    return alreadyBlock(iid, "reopen", "opened", ctx);
  }

  await glabExec(["issue", "reopen", String(iid)], ctx);
  return renderOutput([
    renderDetail("reopened", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "issue", action: "reopen", id: iid, repo: ctx }),
    ),
  ]);
}

async function issueComment(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const iid = takeNumber(args, "issue");
  const body = takeBody(args, { required: true });

  const note = await postNote(iid, body, ctx);
  return renderOutput([
    renderDetail("comment", { ...note, iid }, commentResultSchema),
    renderHelp(
      getSuggestions({
        domain: "issue",
        action: "comment",
        id: iid,
        repo: ctx,
      }),
    ),
  ]);
}

async function issueDelete(args: string[], ctx?: RepoContext): Promise<string> {
  const iid = takeNumber(args, "issue");

  await glabExec(["issue", "delete", String(iid)], ctx);
  return renderOutput([
    renderDetail("deleted", { iid, status: "ok" }, [
      field("iid"),
      field("status"),
    ]),
    renderHelp(
      getSuggestions({ domain: "issue", action: "delete", id: iid, repo: ctx }),
    ),
  ]);
}

/** lock and unlock differ only by the `discussion_locked` value they converge on. */
async function setLocked(
  args: string[],
  locked: boolean,
  ctx?: RepoContext,
): Promise<string> {
  const iid = takeNumber(args, "issue");
  const action = locked ? "lock" : "unlock";

  const issue = await fetchIssue(iid, ctx);
  if (Boolean(issue.discussion_locked) === locked) {
    return alreadyBlock(iid, action, issue.state, ctx);
  }

  await glabExec(
    [
      "issue",
      "update",
      String(iid),
      locked ? "--lock-discussion" : "--unlock-discussion",
    ],
    ctx,
  );
  const updated = await fetchIssue(iid, ctx);
  return renderOutput([
    renderDetail("issue", updated, lockResultSchema),
    renderHelp(getSuggestions({ domain: "issue", action, id: iid, repo: ctx })),
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const HANDLERS: Record<
  string,
  (args: string[], ctx?: RepoContext) => Promise<string>
> = {
  list: issueList,
  view: issueView,
  create: issueCreate,
  edit: issueEdit,
  close: issueClose,
  reopen: issueReopen,
  comment: issueComment,
  delete: issueDelete,
  lock: (args, ctx) => setLocked(args, true, ctx),
  unlock: (args, ctx) => setLocked(args, false, ctx),
};

export async function issueCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return ISSUE_HELP;
  }

  const handler = HANDLERS[sub];
  if (!handler) {
    return renderError(`Unknown issue subcommand: ${sub}`, "VALIDATION_ERROR", [
      "Run `glab-axi issue --help` to see available subcommands",
    ]);
  }

  rejectUnknownFlags(rest, ISSUE_FLAGS[sub], "issue", sub);
  return handler(rest, ctx);
}
