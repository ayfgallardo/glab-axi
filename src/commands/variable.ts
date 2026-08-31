import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabApiJson, glabExec, glabExecWithStdin } from "../glab.js";
import { AxiError } from "../errors.js";
import {
  takeFlag,
  takeBoolFlag,
  rejectUnknownFlags,
  resolveLimit,
} from "../args.js";
import {
  field,
  boolYesNo,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { resolveValue } from "../secretValue.js";

interface GlabVariable {
  key: string;
  value?: string;
  masked?: boolean;
  protected?: boolean;
  environment_scope?: string;
}

const VARIABLE_FLAGS: Record<string, readonly string[]> = {
  list: ["--limit"],
  get: ["--scope"],
  set: ["--masked", "--protected", "--scope"],
  delete: ["--scope"],
};

export const VARIABLE_HELP = `usage: glab-axi variable <subcommand> [flags]
subcommands[4]:
  list, get <name>, set <name>, delete <name>
flags[1]:
  --scope <environment> (get/set/delete): the variable's environment_scope, defaults to * (all)
flags{set}:
  value is read only from piped stdin — never passed as a flag, since flags are visible in process argv
  --masked, --protected
values are not secrets: \`list\`/\`get\` print them, matching \`glab variable list\`/\`get\`
examples:
  glab-axi variable list
  glab-axi variable get NODE_ENV
  echo -n "production" | glab-axi variable set NODE_ENV
  echo -n "sk-..." | glab-axi variable set OPENAI_API_KEY --masked --protected
  glab-axi variable delete NODE_ENV --scope production`;

const listSchema: FieldDef[] = [
  field("key", "name"),
  field("value"),
  boolYesNo("masked"),
  boolYesNo("protected"),
  field("environment_scope", "scope"),
];

function scopeQuery(scope: string | undefined): string {
  return scope
    ? `?filter%5Benvironment_scope%5D=${encodeURIComponent(scope)}`
    : "";
}

async function listVariables(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const limit = resolveLimit(args, 100);
  const variables = await glabApiJson<GlabVariable[]>(
    `projects/:id/variables?per_page=${limit}`,
    { ctx },
  );
  const isEmpty = variables.length === 0;
  const countLine = formatCountLine({ count: variables.length, limit });
  const suggestions = getSuggestions({
    domain: "variable",
    action: "list",
    isEmpty,
    repo: ctx,
  });
  return renderOutput([
    countLine,
    renderList("variables", variables, listSchema),
    renderHelp(suggestions),
  ]);
}

async function getVariable(args: string[], ctx?: RepoContext): Promise<string> {
  const scope = takeFlag(args, "--scope");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const name = positionals[0];
  if (!name) {
    throw new AxiError(
      "Variable name is required: glab-axi variable get <name>",
      "VALIDATION_ERROR",
    );
  }

  const variable = await glabApiJson<GlabVariable>(
    `projects/:id/variables/${encodeURIComponent(name)}${scopeQuery(scope)}`,
    { ctx },
  );
  return renderOutput([renderDetail("variable", variable, listSchema)]);
}

async function setVariable(args: string[], ctx?: RepoContext): Promise<string> {
  const masked = takeBoolFlag(args, "--masked");
  const protectedFlag = takeBoolFlag(args, "--protected");
  const scope = takeFlag(args, "--scope");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const name = positionals[0];
  if (!name) {
    throw new AxiError(
      "Variable name is required: glab-axi variable set <name>",
      "VALIDATION_ERROR",
    );
  }

  const glabArgs = ["variable", "set", name];
  if (masked) glabArgs.push("--masked");
  if (protectedFlag) glabArgs.push("--protected");
  if (scope) glabArgs.push("--scope", scope);

  const value = await resolveValue(undefined, "variable");
  await glabExecWithStdin(glabArgs, value, ctx);

  const suggestions = getSuggestions({
    domain: "variable",
    action: "set",
    id: name,
    repo: ctx,
  });
  return renderOutput([
    encode({ set: "ok", variable: name }),
    renderHelp(suggestions),
  ]);
}

async function deleteVariable(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const scope = takeFlag(args, "--scope");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const name = positionals[0];
  if (!name) {
    throw new AxiError(
      "Variable name is required: glab-axi variable delete <name>",
      "VALIDATION_ERROR",
    );
  }

  const glabArgs = ["variable", "delete", name];
  if (scope) glabArgs.push("--scope", scope);
  await glabExec(glabArgs, ctx);

  const suggestions = getSuggestions({
    domain: "variable",
    action: "delete",
    id: name,
    repo: ctx,
  });
  return renderOutput([
    encode({ delete: "ok", variable: name }),
    renderHelp(suggestions),
  ]);
}

export async function variableCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];

  if (sub === "--help" || sub === undefined) return VARIABLE_HELP;

  const rest = args.slice(1);
  switch (sub) {
    case "list":
      rejectUnknownFlags(rest, VARIABLE_FLAGS.list, "variable", "list");
      return listVariables(rest, ctx);
    case "get":
      rejectUnknownFlags(rest, VARIABLE_FLAGS.get, "variable", "get");
      return getVariable(rest, ctx);
    case "set":
      rejectUnknownFlags(rest, VARIABLE_FLAGS.set, "variable", "set");
      return setVariable(rest, ctx);
    case "delete":
      rejectUnknownFlags(rest, VARIABLE_FLAGS.delete, "variable", "delete");
      return deleteVariable(rest, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list, get, set, delete",
      ]);
  }
}
