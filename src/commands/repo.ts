import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabExec } from "../glab.js";
import { AxiError } from "../errors.js";
import {
  takeFlag,
  takeBoolFlag,
  rejectUnknownFlags,
  resolveLimit,
} from "../args.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import {
  field,
  lower,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";

interface GlabProject {
  path_with_namespace: string;
  description?: string | null;
  default_branch?: string | null;
  star_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  visibility?: string;
  web_url?: string;
  last_activity_at?: string;
}

const REPO_FLAGS: Record<string, readonly string[]> = {
  view: [],
  create: ["--public", "--private", "--internal", "--description", "--group"],
  edit: ["--description", "--default-branch", "--archive", "--unarchive"],
  clone: [],
  fork: ["--clone", "--remote"],
  list: ["--limit", "--visibility", "--archived"],
};

export const REPO_HELP = `usage: glab-axi repo <subcommand> [flags]
subcommands[5]:
  view, create <name>, edit, clone <repo> [dir], fork [repo], list
flags{create}:
  --public, --private, --internal, --description <text>, --group <namespace>
flags{edit}:
  --description <text>, --default-branch <branch>, --archive, --unarchive
flags{fork}:
  --clone, --remote
flags{list}:
  --limit <n> (default 30), --visibility <public|internal|private>, --archived
examples:
  glab-axi repo view
  glab-axi repo view -R group/subgroup/project
  glab-axi repo create my-project --public --description "A new project"
  glab-axi repo list --visibility public`;

const viewSchema: FieldDef[] = [
  field("path_with_namespace", "name"),
  field("description"),
  field("default_branch", "branch"),
  field("star_count", "stars"),
  field("forks_count", "forks"),
  field("open_issues_count", "issues"),
  lower("visibility"),
  field("web_url", "url"),
];

const listSchema: FieldDef[] = [
  field("path_with_namespace", "name"),
  field("description"),
  lower("visibility"),
  field("star_count", "stars"),
  relativeTime("last_activity_at", "updated"),
];

async function viewRepo(_args: string[], ctx?: RepoContext): Promise<string> {
  const repo = await glabApiJson<GlabProject>("projects/:id", { ctx });
  return renderOutput([renderDetail("repo", repo, viewSchema)]);
}

async function createRepo(args: string[], ctx?: RepoContext): Promise<string> {
  const isPublic = takeBoolFlag(args, "--public");
  const isPrivate = takeBoolFlag(args, "--private");
  const isInternal = takeBoolFlag(args, "--internal");
  const description = takeFlag(args, "--description");
  const group = takeFlag(args, "--group");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const name = positionals[0];
  if (!name) {
    throw new AxiError(
      "Repository name is required: glab-axi repo create <name>",
      "VALIDATION_ERROR",
    );
  }

  const glabArgs = ["repo", "create", name];
  if (isPublic) glabArgs.push("--public");
  else if (isPrivate) glabArgs.push("--private");
  else if (isInternal) glabArgs.push("--internal");
  if (description) glabArgs.push("--description", description);
  if (group) glabArgs.push("--group", group);

  await glabExec(glabArgs);
  const suggestions = getSuggestions({
    domain: "repo",
    action: "create",
    repo: ctx,
  });
  return renderOutput([
    encode({ created: "ok", repo: name }),
    renderHelp(suggestions),
  ]);
}

async function editRepo(args: string[], ctx?: RepoContext): Promise<string> {
  const glabArgs = ["repo", "update"];
  if (ctx && ctx.source !== "git") glabArgs.push(ctx.fullPath);
  const description = takeFlag(args, "--description");
  if (description) glabArgs.push("--description", description);
  const defaultBranch = takeFlag(args, "--default-branch");
  if (defaultBranch) glabArgs.push("--defaultBranch", defaultBranch);
  const archive = takeBoolFlag(args, "--archive");
  const unarchive = takeBoolFlag(args, "--unarchive");
  if (archive && unarchive) {
    throw new AxiError(
      "Choose either --archive or --unarchive, not both",
      "VALIDATION_ERROR",
    );
  }
  if (archive) glabArgs.push("--archive");
  if (unarchive) glabArgs.push("--archive=false");

  await glabExec(glabArgs);
  const suggestions = getSuggestions({
    domain: "repo",
    action: "edit",
    repo: ctx,
  });
  return renderOutput([encode({ edit: "ok" }), renderHelp(suggestions)]);
}

async function cloneRepo(args: string[]): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const repo = positionals[0];
  if (!repo) {
    throw new AxiError(
      "Repository is required: glab-axi repo clone <repo>",
      "VALIDATION_ERROR",
    );
  }
  const dir = positionals[1];

  const glabArgs = ["repo", "clone", repo];
  if (dir) glabArgs.push(dir);
  await glabExec(glabArgs);
  const suggestions = getSuggestions({ domain: "repo", action: "clone" });
  return renderOutput([encode({ clone: "ok", repo }), renderHelp(suggestions)]);
}

async function forkRepo(args: string[], ctx?: RepoContext): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const repo = positionals[0] ?? ctx?.fullPath;
  if (!repo) {
    throw new AxiError(
      "Repository is required: glab-axi repo fork <repo>",
      "VALIDATION_ERROR",
    );
  }

  const glabArgs = ["repo", "fork", repo];
  if (takeBoolFlag(args, "--clone")) glabArgs.push("--clone");
  if (takeBoolFlag(args, "--remote")) glabArgs.push("--remote");

  await glabExec(glabArgs);
  const suggestions = getSuggestions({
    domain: "repo",
    action: "fork",
    repo: ctx,
  });
  return renderOutput([encode({ fork: "ok", repo }), renderHelp(suggestions)]);
}

async function listRepos(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = resolveLimit(args, 30);
  const visibility = takeFlag(args, "--visibility");
  const archived = takeBoolFlag(args, "--archived");

  const query = new URLSearchParams({
    membership: "true",
    order_by: "last_activity_at",
    sort: "desc",
    per_page: String(limit),
  });
  if (visibility) query.set("visibility", visibility);
  if (archived) query.set("archived", "true");

  const repos = await glabApiJson<GlabProject[]>(
    `projects?${query.toString()}`,
    {
      ctx,
    },
  );
  const isEmpty = repos.length === 0;
  const countLine = formatCountLine({ count: repos.length, limit });
  const suggestions = getSuggestions({
    domain: "repo",
    action: "list",
    isEmpty,
    repo: ctx,
  });
  return renderOutput([
    countLine,
    renderList("repos", repos, listSchema),
    renderHelp(suggestions),
  ]);
}

export async function repoCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];

  if (sub === "--help" || sub === undefined) return REPO_HELP;

  const rest = args.slice(1);
  switch (sub) {
    case "view":
      rejectUnknownFlags(rest, REPO_FLAGS.view, "repo", "view");
      return viewRepo(rest, ctx);
    case "create":
      rejectUnknownFlags(rest, REPO_FLAGS.create, "repo", "create");
      return createRepo(rest, ctx);
    case "edit":
      rejectUnknownFlags(rest, REPO_FLAGS.edit, "repo", "edit");
      return editRepo(rest, ctx);
    case "clone":
      rejectUnknownFlags(rest, REPO_FLAGS.clone, "repo", "clone");
      return cloneRepo(rest);
    case "fork":
      rejectUnknownFlags(rest, REPO_FLAGS.fork, "repo", "fork");
      return forkRepo(rest, ctx);
    case "list":
      rejectUnknownFlags(rest, REPO_FLAGS.list, "repo", "list");
      return listRepos(rest, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: view, create, edit, clone, fork, list",
      ]);
  }
}
