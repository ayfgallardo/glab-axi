import { encode } from "@toon-format/toon";
import { glabRaw, type ExecResult } from "../glab.js";
import { AxiError, StackError } from "../errors.js";
import {
  takeFlag,
  takeBoolFlag,
  getAllFlags,
  pushRepeated,
  rejectUnknownFlags,
} from "../args.js";

export const STACK_HELP = `usage: glab-axi stack <subcommand> [args] [flags]
subcommands[9]:
  create <name>, save [file...], amend [file...], sync, list, switch <name>, next, prev, first, last
flags{save,amend}:
  -m/-d <text> (required — a message is mandatory so glab never opens $EDITOR), -a/--all (stage tracked+untracked files)
flags{sync}:
  --no-verify, --update-base, --assignee <user> (repeatable), --label <name> (repeatable), --reviewer <user> (repeatable)
notes:
  Operates on the git repository in the current working directory; -R, --repo, and GITLAB_REPO are not supported.
  This wraps glab's own native "glab stack" (EXPERIMENTAL upstream) — no extension to install.
  move and reorder are interactive fuzzy finders and have no non-interactive form; they are not exposed here.
  gh-stack's view/init/add/checkout/push/submit/rebase/link/unstack/merge/up/down/top/bottom/trunk have no
  native "glab stack" equivalent and are dropped; use next/prev/first/last for stack navigation and
  \`glab-axi mr merge\` to merge an individual branch.
  "glab stack sync" may prompt to choose fork vs. upstream when the current repo is a fork — this wrapper
  cannot suppress that prompt; avoid running sync from a forked checkout in an agent context.
examples:
  glab-axi stack create feature-api
  glab-axi stack save -m "add endpoint"
  glab-axi stack amend -a -m "fix typo"
  glab-axi stack sync --update-base
  glab-axi stack list
  glab-axi stack switch feature-api`;

// eslint-disable-next-line no-control-regex -- upstream output may contain ANSI color sequences
const ANSI_ESCAPE = new RegExp("\\u001b\\[[0-9;]*m", "g");

function lines(output: string): string[] {
  return output
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validation(message: string): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [
    "Run `glab-axi stack --help` to see agent-safe forms",
  ]);
}

export async function stackCommand(args: string[]): Promise<string> {
  if (args.length === 0 || args.includes("--help")) return STACK_HELP;

  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create": {
      rejectUnknownFlags(rest, [], "stack", "create");
      const positionals = rest.filter((a) => !a.startsWith("-"));
      if (positionals.length !== 1) {
        throw validation("usage: glab-axi stack create <name>");
      }
      return runStack("create", rest);
    }
    case "save":
    case "amend": {
      const glabArgs = validateSaveOrAmend(subcommand, rest);
      return runStack(subcommand, glabArgs);
    }
    case "sync": {
      const glabArgs = buildSyncArgs(rest);
      return runStack("sync", glabArgs);
    }
    case "list":
      rejectUnknownFlags(rest, [], "stack", "list");
      return runStack("list", rest);
    case "switch": {
      rejectUnknownFlags(rest, [], "stack", "switch");
      const positionals = rest.filter((a) => !a.startsWith("-"));
      if (positionals.length !== 1) {
        throw validation("usage: glab-axi stack switch <stack-name>");
      }
      return runStack("switch", rest);
    }
    case "next":
    case "prev":
    case "first":
    case "last":
      rejectUnknownFlags(rest, [], "stack", subcommand);
      return runStack(subcommand, rest);
    case "move":
    case "reorder":
      throw validation(
        `stack ${subcommand} is an interactive fuzzy finder with no non-interactive form and is not supported`,
      );
    default:
      throw validation(`Unknown stack subcommand: ${subcommand}`);
  }
}

function validateSaveOrAmend(action: string, args: string[]): string[] {
  const glabArgs = [...args];
  const all = takeBoolFlag(glabArgs, "--all") || takeBoolFlag(glabArgs, "-a");
  const message =
    takeFlag(glabArgs, "--message") ??
    takeFlag(glabArgs, "-m") ??
    takeFlag(glabArgs, "--description") ??
    takeFlag(glabArgs, "-d");

  rejectUnknownFlags(glabArgs, [], "stack", action);

  if (message === undefined) {
    throw validation(
      `stack ${action} requires -m/--message (or -d/--description); glab-axi never opens an interactive editor`,
    );
  }

  const out = [...glabArgs];
  if (all) out.push("--all");
  out.push("--message", message);
  return out;
}

function buildSyncArgs(args: string[]): string[] {
  const glabArgs = [...args];
  const noVerify = takeBoolFlag(glabArgs, "--no-verify");
  const updateBase = takeBoolFlag(glabArgs, "--update-base");
  const assignees = getAllFlags(glabArgs, "--assignee");
  const labels = getAllFlags(glabArgs, "--label");
  const reviewers = getAllFlags(glabArgs, "--reviewer");

  rejectUnknownFlags(
    glabArgs,
    ["--assignee", "--label", "--reviewer"],
    "stack",
    "sync",
  );

  const out: string[] = [];
  if (noVerify) out.push("--no-verify");
  if (updateBase) out.push("--update-base");
  pushRepeated(out, "--assignee", assignees);
  pushRepeated(out, "--label", labels);
  pushRepeated(out, "--reviewer", reviewers);
  return out;
}

async function runStack(action: string, args: string[]): Promise<string> {
  const result = await execute(action, args);
  const messages = [...lines(result.stdout), ...lines(result.stderr)];
  return encode({
    stack: {
      action,
      status: "ok",
      output: messages.length > 0 ? messages : ["completed"],
    },
  });
}

async function execute(action: string, args: string[]): Promise<ExecResult> {
  const result = await glabRaw(["stack", action, ...args]);
  if (result.exitCode === 0) return result;

  const diagnostics = [...lines(result.stderr), ...lines(result.stdout)];
  const message =
    diagnostics.join("\n") ||
    `glab stack ${action} exited with code ${result.exitCode}`;
  throw new StackError(message, result.exitCode, [
    `Run \`glab stack ${action} --help\` to inspect the underlying command`,
  ]);
}
