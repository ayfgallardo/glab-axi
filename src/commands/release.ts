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
import { takeBody, truncateBody } from "../body.js";
import {
  field,
  relativeTime,
  pluck,
  custom,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";

interface GlabAuthor {
  username?: string;
}

interface GlabRelease {
  tag_name: string;
  name?: string;
  description?: string | null;
  released_at?: string;
  author?: GlabAuthor;
}

const RELEASE_FLAGS: Record<string, readonly string[]> = {
  list: ["--limit"],
  view: ["--full"],
  create: [
    "--body",
    "--body-file",
    "--title",
    "--target",
    "--milestone",
    "--released-at",
  ],
  edit: [
    "--body",
    "--body-file",
    "--title",
    "--target",
    "--milestone",
    "--released-at",
  ],
  delete: ["--with-tag"],
  download: ["--pattern", "--dir"],
  upload: [],
};

export const RELEASE_HELP = `usage: glab-axi release <subcommand> [flags]
subcommands[7]:
  list, view <tag>, create <tag>, edit <tag>, delete <tag>, download [tag], upload <tag>
flags{list}:
  --limit <n> (default 30)
flags{view}:
  --full (show complete release notes without truncation)
flags{create}:
  --title <text>, --body <text> or --body-file <path> (release notes), --target <ref>, --milestone <title>, --released-at <ISO8601>, <files...>
flags{edit}:
  same as create — glab release create also updates an existing release
flags{delete}:
  --with-tag (also delete the underlying Git tag)
flags{download}:
  --pattern <glob>, --dir <path>
GitLab has no draft/prerelease concept: --draft, --prerelease, --generate-notes and friends have no equivalent and are not accepted.
examples:
  glab-axi release list
  glab-axi release view v1.2.0 --full
  glab-axi release create v1.3.0 --body-file notes.md dist/app.zip
  glab-axi release edit v1.3.0 --title "v1.3.0 — fixes"`;

const listSchema: FieldDef[] = [
  field("tag_name", "tag"),
  field("name"),
  relativeTime("released_at", "released"),
  pluck("author", "username", "author"),
];

const viewSchema: FieldDef[] = [
  field("tag_name", "tag"),
  field("name"),
  relativeTime("released_at", "released"),
  pluck("author", "username", "author"),
  custom("body", (item: GlabRelease) => truncateBody(item.description, 1000)),
];

const viewSchemaFull: FieldDef[] = [
  field("tag_name", "tag"),
  field("name"),
  relativeTime("released_at", "released"),
  pluck("author", "username", "author"),
  custom("body", (item: GlabRelease) =>
    typeof item.description === "string" ? item.description : "",
  ),
];

function releasePath(tag: string, suffix = ""): string {
  return `projects/:id/releases/${encodeURIComponent(tag)}${suffix}`;
}

async function fetchRelease(
  tag: string,
  ctx?: RepoContext,
): Promise<GlabRelease> {
  return glabApiJson<GlabRelease>(releasePath(tag), { ctx });
}

function appendNotesFlags(glabArgs: string[], args: string[]): void {
  const body = takeBody(args, { label: "release notes" });
  if (body !== undefined) glabArgs.push("--notes", body);
  const title = takeFlag(args, "--title");
  if (title) glabArgs.push("--name", title);
  const target = takeFlag(args, "--target");
  if (target) glabArgs.push("--ref", target);
  const milestone = takeFlag(args, "--milestone");
  if (milestone) glabArgs.push("--milestone", milestone);
  const releasedAt = takeFlag(args, "--released-at");
  if (releasedAt) glabArgs.push("--released-at", releasedAt);
}

async function listReleases(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const limit = resolveLimit(args, 30);
  const releases = await glabApiJson<GlabRelease[]>(
    `projects/:id/releases?per_page=${limit}`,
    { ctx },
  );
  const isEmpty = releases.length === 0;
  const countLine = formatCountLine({ count: releases.length, limit });
  const suggestions = getSuggestions({
    domain: "release",
    action: "list",
    isEmpty,
    repo: ctx,
  });
  return renderOutput([
    countLine,
    renderList("releases", releases, listSchema),
    renderHelp(suggestions),
  ]);
}

async function viewRelease(args: string[], ctx?: RepoContext): Promise<string> {
  const full = takeBoolFlag(args, "--full");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];
  if (!tag) {
    throw new AxiError(
      "Tag is required: glab-axi release view <tag>",
      "VALIDATION_ERROR",
    );
  }

  const release = await fetchRelease(tag, ctx);
  return renderOutput([
    renderDetail("release", release, full ? viewSchemaFull : viewSchema),
  ]);
}

async function createRelease(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const notesArgs: string[] = [];
  appendNotesFlags(notesArgs, args);
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];
  if (!tag) {
    throw new AxiError(
      "Tag is required: glab-axi release create <tag>",
      "VALIDATION_ERROR",
    );
  }
  const files = positionals.slice(1);

  const glabArgs = ["release", "create", tag, ...notesArgs, ...files];

  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "release",
    action: "create",
    id: tag,
    repo: ctx,
  });
  return renderOutput([
    encode({ created: "ok", tag }),
    renderHelp(suggestions),
  ]);
}

async function editRelease(args: string[], ctx?: RepoContext): Promise<string> {
  const notesArgs: string[] = [];
  appendNotesFlags(notesArgs, args);
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];
  if (!tag) {
    throw new AxiError(
      "Tag is required: glab-axi release edit <tag>",
      "VALIDATION_ERROR",
    );
  }

  // GitLab has no dedicated update endpoint: `glab release create` also
  // updates an existing release when its tag already exists.
  const glabArgs = ["release", "create", tag, ...notesArgs];

  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "release",
    action: "edit",
    id: tag,
    repo: ctx,
  });
  return renderOutput([encode({ edit: "ok", tag }), renderHelp(suggestions)]);
}

async function deleteRelease(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const withTag = takeBoolFlag(args, "--with-tag");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];
  if (!tag) {
    throw new AxiError(
      "Tag is required: glab-axi release delete <tag>",
      "VALIDATION_ERROR",
    );
  }

  try {
    await fetchRelease(tag, ctx);
  } catch (err) {
    if (err instanceof AxiError && err.code === "NOT_FOUND") {
      const suggestions = getSuggestions({
        domain: "release",
        action: "delete",
        id: tag,
        repo: ctx,
      });
      return renderOutput([
        encode({ delete: "already_deleted", tag }),
        renderHelp(suggestions),
      ]);
    }
    throw err;
  }

  const glabArgs = ["release", "delete", tag, "--yes"];
  if (withTag) glabArgs.push("--with-tag");
  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "release",
    action: "delete",
    id: tag,
    repo: ctx,
  });
  return renderOutput([encode({ delete: "ok", tag }), renderHelp(suggestions)]);
}

async function downloadRelease(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];

  const glabArgs = ["release", "download"];
  if (tag) glabArgs.push(tag);
  const pattern = takeFlag(args, "--pattern");
  if (pattern) glabArgs.push("--asset-name", pattern);
  const dir = takeFlag(args, "--dir");
  if (dir) glabArgs.push("--dir", dir);

  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "release",
    action: "download",
    id: tag,
    repo: ctx,
  });
  return renderOutput([
    encode({ download: "ok", tag: tag ?? "latest" }),
    renderHelp(suggestions),
  ]);
}

async function uploadRelease(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const tag = positionals[0];
  if (!tag) {
    throw new AxiError(
      "Tag is required: glab-axi release upload <tag> <files...>",
      "VALIDATION_ERROR",
    );
  }
  const files = positionals.slice(1);
  if (files.length === 0) {
    throw new AxiError(
      "At least one file is required: glab-axi release upload <tag> <files...>",
      "VALIDATION_ERROR",
    );
  }

  await glabExec(["release", "upload", tag, ...files], ctx);
  const suggestions = getSuggestions({
    domain: "release",
    action: "upload",
    id: tag,
    repo: ctx,
  });
  return renderOutput([
    encode({ upload: "ok", tag, files: files.length }),
    renderHelp(suggestions),
  ]);
}

export async function releaseCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];

  if (sub === "--help" || sub === undefined) return RELEASE_HELP;

  const rest = args.slice(1);
  switch (sub) {
    case "list":
      rejectUnknownFlags(rest, RELEASE_FLAGS.list, "release", "list");
      return listReleases(rest, ctx);
    case "view":
      rejectUnknownFlags(rest, RELEASE_FLAGS.view, "release", "view");
      return viewRelease(rest, ctx);
    case "create":
      rejectUnknownFlags(rest, RELEASE_FLAGS.create, "release", "create");
      return createRelease(rest, ctx);
    case "edit":
      rejectUnknownFlags(rest, RELEASE_FLAGS.edit, "release", "edit");
      return editRelease(rest, ctx);
    case "delete":
      rejectUnknownFlags(rest, RELEASE_FLAGS.delete, "release", "delete");
      return deleteRelease(rest, ctx);
    case "download":
      rejectUnknownFlags(rest, RELEASE_FLAGS.download, "release", "download");
      return downloadRelease(rest, ctx);
    case "upload":
      rejectUnknownFlags(rest, RELEASE_FLAGS.upload, "release", "upload");
      return uploadRelease(rest, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list, view, create, edit, delete, download, upload",
      ]);
  }
}
