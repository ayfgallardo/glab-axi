import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabApiText } from "../glab.js";
import { AxiError } from "../errors.js";
import {
  takeFlag,
  takeBoolFlag,
  rejectUnknownFlags,
  resolveLimit,
} from "../args.js";
import {
  field,
  custom,
  relativeTime,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { isStdinTTY, readStdin } from "../stdin.js";
import { snippetIdFromSelector } from "../snippetSelector.js";

export const SNIPPET_HELP = `usage: glab-axi snippet <subcommand> [flags]
subcommands[5]:
  list, view <id|url>, create, edit <id|url>, delete <id|url>
notes:
  Project snippets (default) live at projects/:id/snippets. Pass --personal
  for the caller's personal snippets (no project scope, no -R/--repo).
flags{list}:
  --personal, --limit <n> (default 100)
flags{view}:
  --personal, --files (file names only), --full (no truncation)
flags{create}:
  --personal, -t/--title <text> (required), --file <path> (repeatable),
  --filename <name> (for piped content), -d/--desc <text>,
  --visibility <public|internal|private> (default private)
flags{edit}:
  --personal, -t/--title <text>, -d/--desc <text>,
  --add <path> or --add <name> - (from piped stdin), --remove <name>
flags{delete}:
  --personal
examples:
  glab-axi snippet list
  glab-axi snippet list --personal --limit 20
  glab-axi snippet view 42
  glab-axi snippet view https://gitlab.com/group/project/-/snippets/42
  glab-axi snippet create notes.md --title "My notes"
  glab-axi snippet create --file a.py --file b.py --title "Two files" --visibility internal
  echo "content" | glab-axi snippet create --filename hello.txt --title "Hello" --personal
  glab-axi snippet edit 42 --title "Updated notes"
  echo 'new content' | glab-axi snippet edit 42 --add notes.md -
  glab-axi snippet edit 42 --remove old.txt
  glab-axi snippet delete 42`;

/** GitLab caps a page at 100 items; also this endpoint's per_page ceiling. */
const PAGE_SIZE = 100;

interface SnippetFile {
  path: string;
  raw_url: string;
}

interface SnippetSummary {
  id: number;
  title: string;
  description: string | null;
  visibility: string;
  updated_at: string;
  web_url: string;
  files?: SnippetFile[];
}

const listSchema: FieldDef[] = [
  field("id"),
  field("title"),
  field("visibility"),
  relativeTime("updated_at", "updated"),
  field("web_url", "url"),
];

const detailSchema: FieldDef[] = [
  field("id"),
  field("title"),
  field("description"),
  field("visibility"),
  relativeTime("updated_at", "updated"),
  custom(
    "files",
    (item: SnippetSummary) =>
      (item.files ?? []).map((f) => f.path).join(",") || "none",
  ),
  field("web_url", "url"),
];

/** Maximum characters of raw content shown in the default (non-full) view. */
const CONTENT_MAX_LEN = 1500;

function truncateContent(content: string, full: boolean): string {
  if (full || content.length <= CONTENT_MAX_LEN) return content;
  return (
    content.slice(0, CONTENT_MAX_LEN) +
    `\n... (truncated, ${content.length} chars total - use --full)`
  );
}

/** projects/:id/snippets when scoped to a project, /snippets when personal. */
function basePath(personal: boolean): string {
  return personal ? "/snippets" : "projects/:id/snippets";
}

/** Read piped stdin, rejecting a zero-length read (nothing was actually piped). */
async function readRequiredStdin(example: string): Promise<string> {
  const content = await readStdin();
  if (content.length === 0) {
    throw new AxiError(
      "no content received on stdin; nothing was piped",
      "VALIDATION_ERROR",
      [example],
    );
  }
  return content;
}

async function listSnippets(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const personal = takeBoolFlag(args, "--personal");
  const limit = resolveLimit(args, PAGE_SIZE);

  if (!personal && !ctx) {
    throw new AxiError(
      "no project in context; pass -R/--repo or run from a git checkout, or use --personal",
      "VALIDATION_ERROR",
    );
  }

  const snippets = await glabApiJson<SnippetSummary[]>(
    `${basePath(personal)}?per_page=${limit}`,
    { ctx: personal ? undefined : ctx },
  );

  const isEmpty = snippets.length === 0;
  const countLine = formatCountLine({ count: snippets.length, limit });
  const suggestions = getSuggestions({
    domain: "snippet",
    action: "list",
    isEmpty,
    repo: ctx,
  });
  return renderOutput([
    countLine,
    renderList("snippets", snippets, listSchema),
    renderHelp(suggestions),
  ]);
}

async function viewSnippet(args: string[], ctx?: RepoContext): Promise<string> {
  const personal = takeBoolFlag(args, "--personal");
  const full = takeBoolFlag(args, "--full");
  const filesOnly = takeBoolFlag(args, "--files");

  const positionals = args.slice(1).filter((a) => !a.startsWith("-"));
  const selector = positionals[0];
  if (!selector) {
    throw new AxiError(
      "snippet view requires a snippet id or URL",
      "VALIDATION_ERROR",
      ["Usage: glab-axi snippet view <id|url>"],
    );
  }
  if (positionals.length > 1) {
    throw new AxiError(
      `Unexpected argument: ${positionals[1]}`,
      "VALIDATION_ERROR",
    );
  }

  const id = snippetIdFromSelector(selector);
  const effectiveCtx = personal ? undefined : ctx;
  const path = `${basePath(personal)}/${id}`;
  const data = await glabApiJson<SnippetSummary>(path, { ctx: effectiveCtx });

  const suggestions = getSuggestions({
    domain: "snippet",
    action: "view",
    id,
    repo: ctx,
  });

  if (filesOnly) {
    return renderOutput([
      renderList(
        "files",
        (data.files ?? []).map((f) => ({ path: f.path })),
        [field("path")],
      ),
      renderHelp(suggestions),
    ]);
  }

  const raw = await glabApiText(`${path}/raw`, { ctx: effectiveCtx });
  return renderOutput([
    renderDetail(
      "snippet",
      data as unknown as Record<string, unknown>,
      detailSchema,
    ),
    encode({ content: truncateContent(raw, full) }),
    renderHelp(suggestions),
  ]);
}

async function createSnippet(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const personal = takeBoolFlag(args, "--personal");
  const titleShort = takeFlag(args, "-t");
  const titleLong = takeFlag(args, "--title");
  const title = titleShort ?? titleLong;
  if (!title) {
    throw new AxiError(
      "--title is required: glab-axi snippet create --title <text> ...",
      "VALIDATION_ERROR",
    );
  }
  const descShort = takeFlag(args, "-d");
  const descLong = takeFlag(args, "--desc");
  const description = descShort ?? descLong;
  const visibility = takeFlag(args, "--visibility") ?? "private";
  if (!["public", "internal", "private"].includes(visibility)) {
    throw new AxiError(
      `--visibility must be public, internal, or private, got: ${visibility}`,
      "VALIDATION_ERROR",
    );
  }
  const filename = takeFlag(args, "--filename");
  const fileFlags: string[] = [];
  {
    const rest = args;
    let flag: string | undefined;
    while ((flag = takeFlag(rest, "--file")) !== undefined) {
      fileFlags.push(flag);
    }
  }

  const remaining = args.filter((a) => a !== "create");
  const positionals = remaining.filter((a) => !a.startsWith("-"));

  if (positionals.length > 0 && fileFlags.length > 0) {
    throw new AxiError(
      "Cannot mix positional paths with --file; use one form",
      "VALIDATION_ERROR",
    );
  }
  const hasFileArgs = positionals.length > 0 || fileFlags.length > 0;
  if (hasFileArgs && filename !== undefined) {
    throw new AxiError(
      "Cannot mix file paths with --filename; use one input form",
      "VALIDATION_ERROR",
    );
  }
  if (!hasFileArgs && filename === undefined) {
    throw new AxiError(
      "snippet create requires at least one file: pass positional path(s), " +
        "--file <path>, or pipe content with --filename <name>",
      "VALIDATION_ERROR",
    );
  }

  const effectiveCtx = personal ? undefined : ctx;
  if (!personal && !ctx) {
    throw new AxiError(
      "no project in context; pass -R/--repo or run from a git checkout, or use --personal",
      "VALIDATION_ERROR",
    );
  }

  const fields: Record<string, string> = { title, visibility };
  if (description) fields.description = description;

  let filePath: string;
  let content: string;

  if (filename !== undefined) {
    if (isStdinTTY()) {
      throw new AxiError(
        "--filename requires piped content on stdin; no pipe was detected",
        "VALIDATION_ERROR",
        [
          `echo 'content' | glab-axi snippet create --filename <name> --title <text>`,
        ],
      );
    }
    filePath = filename;
    content = await readRequiredStdin(
      `echo 'content' | glab-axi snippet create --filename <name> --title <text>`,
    );
  } else {
    const path = positionals.length > 0 ? positionals[0] : fileFlags[0];
    filePath = path.split("/").pop() ?? path;
    content = await readFileContent(path);
  }

  fields["files[0][file_path]"] = filePath;
  fields["files[0][content]"] = content;

  const created = await glabApiJson<SnippetSummary>(basePath(personal), {
    ctx: effectiveCtx,
    method: "POST",
    fields,
  });

  const suggestions = getSuggestions({
    domain: "snippet",
    action: "create",
    id: created.id,
    repo: ctx,
  });
  return renderOutput([
    renderDetail(
      "created",
      { id: created.id, url: created.web_url, visibility },
      [field("id"), field("url"), field("visibility")],
    ),
    renderHelp(suggestions),
  ]);
}

async function readFileContent(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new AxiError(
      `Could not read file "${path}": ${(err as Error).message}`,
      "VALIDATION_ERROR",
    );
  }
}

async function editSnippet(args: string[], ctx?: RepoContext): Promise<string> {
  const personal = takeBoolFlag(args, "--personal");
  const rest = args.slice(1);
  const titleFlag = takeFlag(rest, "--title") ?? takeFlag(rest, "-t");
  const descFlag = takeFlag(rest, "--desc") ?? takeFlag(rest, "-d");
  const visibilityFlag = takeFlag(rest, "--visibility");
  const addFlag = takeFlag(rest, "--add") ?? takeFlag(rest, "-a");
  const removeFlag = takeFlag(rest, "--remove") ?? takeFlag(rest, "-r");

  rejectUnknownFlags(
    rest,
    [
      "-",
      "--title",
      "-t",
      "--desc",
      "-d",
      "--visibility",
      "--add",
      "-a",
      "--remove",
      "-r",
    ],
    "snippet",
    "edit",
  );

  const wantsStdin = rest.includes("-");
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const id = positionals[0];
  if (!id) {
    throw new AxiError(
      "Snippet id or URL is required: glab-axi snippet edit <id|url> [flags]",
      "VALIDATION_ERROR",
    );
  }
  if (positionals.length > 1) {
    throw new AxiError(
      `Unexpected argument: ${positionals[1]}`,
      "VALIDATION_ERROR",
    );
  }

  if (addFlag !== undefined && removeFlag !== undefined) {
    throw new AxiError(
      "--add and --remove are mutually exclusive; pass only one per invocation",
      "VALIDATION_ERROR",
    );
  }

  if (
    titleFlag === undefined &&
    descFlag === undefined &&
    visibilityFlag === undefined &&
    addFlag === undefined &&
    removeFlag === undefined
  ) {
    throw new AxiError(
      "nothing to edit; pass --title, --desc, --visibility, --add <path|name>, or --remove <name>",
      "VALIDATION_ERROR",
    );
  }

  if (wantsStdin && addFlag === undefined) {
    throw new AxiError(
      "stdin content (-) requires --add <name> to identify the target file",
      "VALIDATION_ERROR",
      ["Example: echo 'content' | glab-axi snippet edit <id> --add <name> -"],
    );
  }

  const snippetId = snippetIdFromSelector(id);
  const effectiveCtx = personal ? undefined : ctx;
  const path = `${basePath(personal)}/${snippetId}`;

  const fields: Record<string, string> = {};
  if (titleFlag !== undefined) fields.title = titleFlag;
  if (descFlag !== undefined) fields.description = descFlag;
  if (visibilityFlag !== undefined) fields.visibility = visibilityFlag;

  if (addFlag !== undefined) {
    let content: string;
    if (wantsStdin) {
      if (isStdinTTY()) {
        throw new AxiError(
          "--add with the stdin sentinel (-) requires content piped via stdin",
          "VALIDATION_ERROR",
          [
            "Example: echo 'content' | glab-axi snippet edit <id> --add <name> -",
          ],
        );
      }
      content = await readRequiredStdin(
        "Example: echo 'content' | glab-axi snippet edit <id> --add <name> -",
      );
      fields["files[0][file_path]"] = addFlag;
      fields["files[0][content]"] = content;
      fields["files[0][action]"] = "create";
    } else {
      content = await readFileContent(addFlag);
      const filePath = addFlag.split("/").pop() ?? addFlag;
      fields["files[0][file_path]"] = filePath;
      fields["files[0][content]"] = content;
      fields["files[0][action]"] = "create";
    }
  } else if (removeFlag !== undefined) {
    fields["files[0][file_path]"] = removeFlag;
    fields["files[0][action]"] = "delete";
  }

  await glabApiJson(path, { ctx: effectiveCtx, method: "PUT", fields });

  const suggestions = getSuggestions({
    domain: "snippet",
    action: "edit",
    id: snippetId,
    repo: ctx,
  });
  return renderOutput([
    encode({ edited: "ok", snippet: snippetId }),
    renderHelp(suggestions),
  ]);
}

async function deleteSnippet(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const personal = takeBoolFlag(args, "--personal");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const selector = positionals[1]; // positionals[0] == "delete"
  const extra = positionals[2];

  if (!selector) {
    throw new AxiError(
      "Snippet is required: glab-axi snippet delete <id|url>",
      "VALIDATION_ERROR",
    );
  }
  if (extra) {
    throw new AxiError(`Unexpected argument: ${extra}`, "VALIDATION_ERROR");
  }

  const id = snippetIdFromSelector(selector);
  const effectiveCtx = personal ? undefined : ctx;

  await glabApiText(`${basePath(personal)}/${id}`, {
    ctx: effectiveCtx,
    method: "DELETE",
  });

  const suggestions = getSuggestions({
    domain: "snippet",
    action: "delete",
    repo: ctx,
  });
  return renderOutput([encode({ deleted: id }), renderHelp(suggestions)]);
}

export async function snippetCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  if (sub === "--help" || sub === undefined) return SNIPPET_HELP;

  switch (sub) {
    case "list":
      return listSnippets(args.slice(1), ctx);
    case "view":
      return viewSnippet(args, ctx);
    case "create":
      return createSnippet(args.slice(1), ctx);
    case "edit":
      return editSnippet(args, ctx);
    case "delete":
      return deleteSnippet(args, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list, view, create, edit, delete",
      ]);
  }
}
