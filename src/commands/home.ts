import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson } from "../glab.js";
import {
  field,
  pluck,
  custom,
  renderList,
  renderHelp,
  renderOutput,
  type FieldDef,
} from "../toon.js";
import { getSuggestions } from "../suggestions.js";

interface GlabUser {
  username?: string;
}

interface GlabMr {
  iid: number;
  title: string;
  author?: GlabUser;
}

interface GlabIssue {
  iid: number;
  title: string;
  author?: GlabUser;
}

interface GlabTodoProject {
  path_with_namespace?: string;
}

interface GlabTodo {
  action_name?: string;
  target_type?: string;
  project?: GlabTodoProject;
}

export const HOME_HELP = "";

const mrSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  pluck("author", "username", "author"),
];

const issueSchema: FieldDef[] = [
  field("iid"),
  field("title"),
  pluck("author", "username", "author"),
];

const todoSchema: FieldDef[] = [
  custom(
    "project",
    (item: GlabTodo) => item.project?.path_with_namespace ?? "unknown",
  ),
  field("target_type"),
  field("action_name"),
];

export async function homeCommand(
  _args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const [user, mrs, issues, todos] = await Promise.all([
    glabApiJson<GlabUser>("user").catch(() => undefined),
    glabApiJson<GlabMr[]>(
      "merge_requests?scope=assigned_to_me&state=opened&per_page=3",
    ).catch(() => [] as GlabMr[]),
    glabApiJson<GlabIssue[]>(
      "issues?scope=assigned_to_me&state=opened&per_page=3",
    ).catch(() => [] as GlabIssue[]),
    glabApiJson<GlabTodo[]>("todos?per_page=3").catch(() => [] as GlabTodo[]),
  ]);

  const blocks: string[] = [];

  if (user?.username) {
    blocks.push(encode({ user: user.username }));
  }

  blocks.push(
    mrs.length
      ? renderList("assigned_mrs", mrs, mrSchema)
      : "assigned_mrs: 0 open",
  );
  blocks.push(
    issues.length
      ? renderList("assigned_issues", issues, issueSchema)
      : "assigned_issues: 0 open",
  );
  blocks.push(
    todos.length ? renderList("todos", todos, todoSchema) : "todos: 0 pending",
  );

  const hints: string[] = [];
  if (mrs.length >= 3)
    hints.push("Run `glab-axi mr list` for the full merge request list");
  if (issues.length >= 3)
    hints.push("Run `glab-axi issue list` for the full issue list");
  const suggestions = getSuggestions({
    domain: "home",
    action: "home",
    repo: ctx,
  });
  blocks.push(renderHelp([...hints, ...suggestions]));

  return renderOutput(blocks);
}
