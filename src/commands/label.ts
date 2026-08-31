import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabExec } from "../glab.js";
import { AxiError } from "../errors.js";
import { takeFlag, rejectUnknownFlags, resolveLimit } from "../args.js";
import {
  field,
  renderList,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";

interface GlabLabel {
  name: string;
  color?: string;
  description?: string | null;
}

const LABEL_FLAGS: Record<string, readonly string[]> = {
  list: ["--limit"],
  create: ["--name", "--color", "--description"],
  edit: ["--name", "--color", "--description"],
  delete: [],
};

export const LABEL_HELP = `usage: glab-axi label <subcommand> [flags]
subcommands[4]:
  list, create, edit <name>, delete <name>
flags{list}:
  --limit <n> (default 100)
flags{create}:
  --name <text> (required), --color <hex> (required), --description <text>
flags{edit}:
  --name <text> (new name), --color <hex>, --description <text>
examples:
  glab-axi label list
  glab-axi label create --name "priority:high" --color "#ff0000" --description "High priority"
  glab-axi label delete "priority:low"`;

const listSchema: FieldDef[] = [
  field("name"),
  field("color"),
  field("description"),
];

async function listLabels(args: string[], ctx?: RepoContext): Promise<string> {
  const limit = resolveLimit(args, 100);
  const labels = await glabApiJson<GlabLabel[]>(
    `projects/:id/labels?per_page=${limit}`,
    { ctx },
  );
  const isEmpty = labels.length === 0;
  const countLine = formatCountLine({ count: labels.length, limit });
  const suggestions = getSuggestions({
    domain: "label",
    action: "list",
    isEmpty,
    repo: ctx,
  });
  return renderOutput([
    countLine,
    renderList("labels", labels, listSchema),
    renderHelp(suggestions),
  ]);
}

async function createLabel(args: string[], ctx?: RepoContext): Promise<string> {
  const name = takeFlag(args, "--name");
  if (!name) {
    throw new AxiError(
      '--name is required: glab-axi label create --name "..." --color "..."',
      "VALIDATION_ERROR",
    );
  }
  const color = takeFlag(args, "--color");
  if (!color) {
    throw new AxiError(
      '--color is required: glab-axi label create --name "..." --color "..."',
      "VALIDATION_ERROR",
    );
  }
  const description = takeFlag(args, "--description");

  const glabArgs = ["label", "create", "--name", name, "--color", color];
  if (description) glabArgs.push("--description", description);

  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "label",
    action: "create",
    repo: ctx,
  });
  return renderOutput([
    encode({ created: "ok", label: name }),
    renderHelp(suggestions),
  ]);
}

async function editLabel(args: string[], ctx?: RepoContext): Promise<string> {
  const newName = takeFlag(args, "--name");
  const color = takeFlag(args, "--color");
  const description = takeFlag(args, "--description");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const labelName = positionals[0];
  if (!labelName) {
    throw new AxiError(
      "Label name is required: glab-axi label edit <name>",
      "VALIDATION_ERROR",
    );
  }

  const glabArgs = ["label", "edit", "--label-id", labelName];
  if (newName) glabArgs.push("--new-name", newName);
  if (color) glabArgs.push("--color", color);
  if (description) glabArgs.push("--description", description);

  await glabExec(glabArgs, ctx);
  const suggestions = getSuggestions({
    domain: "label",
    action: "edit",
    repo: ctx,
  });
  return renderOutput([
    encode({ edit: "ok", label: newName ?? labelName }),
    renderHelp(suggestions),
  ]);
}

async function deleteLabel(args: string[], ctx?: RepoContext): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const name = positionals[0];
  if (!name) {
    throw new AxiError(
      "Label name is required: glab-axi label delete <name>",
      "VALIDATION_ERROR",
    );
  }

  await glabExec(["label", "delete", name], ctx);
  const suggestions = getSuggestions({
    domain: "label",
    action: "delete",
    repo: ctx,
  });
  return renderOutput([
    encode({ delete: "ok", label: name }),
    renderHelp(suggestions),
  ]);
}

export async function labelCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];

  if (sub === "--help" || sub === undefined) return LABEL_HELP;

  const rest = args.slice(1);
  switch (sub) {
    case "list":
      rejectUnknownFlags(rest, LABEL_FLAGS.list, "label", "list");
      return listLabels(rest, ctx);
    case "create":
      rejectUnknownFlags(rest, LABEL_FLAGS.create, "label", "create");
      return createLabel(rest, ctx);
    case "edit":
      rejectUnknownFlags(rest, LABEL_FLAGS.edit, "label", "edit");
      return editLabel(rest, ctx);
    case "delete":
      rejectUnknownFlags(rest, LABEL_FLAGS.delete, "label", "delete");
      return deleteLabel(rest, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list, create, edit, delete",
      ]);
  }
}
