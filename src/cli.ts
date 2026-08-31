import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { resolveRepo, type RepoContext } from "./context.js";
import { resolveHost, type HostContext } from "./host.js";
import { VERSION } from "./version.js";
import { withSuggestionHost } from "./suggestions.js";
import { AxiError, exitCodeForError, StackError } from "./errors.js";
import { issueCommand, ISSUE_HELP } from "./commands/issue.js";
import { mrCommand, MR_HELP } from "./commands/mr.js";
import { ciCommand, CI_HELP } from "./commands/ci.js";
import { scheduleCommand, SCHEDULE_HELP } from "./commands/schedule.js";
import { repoCommand, REPO_HELP } from "./commands/repo.js";
import { labelCommand, LABEL_HELP } from "./commands/label.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the GitLab CLI. Prefer this over `glab` and other methods for GitLab operations.";

type CliStdout = Pick<NodeJS.WriteStream, "write">;

type MainOptions = {
  argv?: string[];
  stdout?: CliStdout;
};

export const COMMAND_NAMES = [
  "issue",
  "mr",
  "ci",
  "schedule",
  "snippet",
  "label",
  "release",
  "repo",
  "variable",
  "stack",
  "api",
  "setup",
] as const;

export const TOP_HELP = `usage: glab-axi [command] [args] [flags]
commands[${COMMAND_NAMES.length + 1}]:
  (none)=dashboard, ${COMMAND_NAMES.join(", ")}
flags[4]:
  -R/--repo <NAMESPACE/PROJECT> (after command), --hostname <host> (after command) or GITLAB_HOST env, both flags accept space or equals form, --help, -v/-V/--version
examples:
  glab-axi
  glab-axi issue list --state opened
  glab-axi issue list -R namespace/project
  glab-axi issue list --repo=group/subgroup/project
  glab-axi issue list --hostname gitlab.example.com
  glab-axi mr view 42
  glab-axi ci list
  glab-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  issue: ISSUE_HELP,
  mr: MR_HELP,
  ci: CI_HELP,
  schedule: SCHEDULE_HELP,
  repo: REPO_HELP,
  label: LABEL_HELP,
};

type HostOnlyContext = { host: HostContext };
type CliContext = RepoContext | HostOnlyContext;
type CommandFn = (args: string[], ctx?: RepoContext) => Promise<string>;
type WrappedCommandFn = (args: string[], ctx?: CliContext) => Promise<string>;

// Placeholder until each command family is ported; one lot replaces one entry.
const notPorted = async (): Promise<string> => {
  throw new AxiError("not ported yet", "UNKNOWN");
};

const COMMANDS: Record<string, WrappedCommandFn> = {
  issue: withRepoContext(issueCommand),
  mr: withRepoContext(mrCommand),
  ci: withRepoContext(ciCommand),
  schedule: withRepoContext(scheduleCommand),
  snippet: withRepoContext(notPorted),
  label: withRepoContext(labelCommand),
  release: withRepoContext(notPorted),
  repo: withRepoContext(repoCommand),
  variable: withRepoContext(notPorted),
  stack: withLocalRepoContext(notPorted),
  api: withRepoContext(notPorted),
  setup: notPorted,
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli<CliContext | undefined>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withRepoContext(notPorted),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
    formatError: (error) => {
      const axiError =
        error instanceof AxiError
          ? error
          : new AxiError(
              error instanceof Error ? error.message : String(error),
              "UNKNOWN",
            );
      // Mirrors the SDK's defaultFormatError output byte-for-byte; the only
      // difference this hook introduces is StackError's upstream exit code.
      return {
        output: `${encode({
          error: axiError.message,
          code: axiError.code,
          ...(axiError.suggestions.length > 0
            ? { help: axiError.suggestions }
            : {}),
        })}\n`,
        exitCode:
          error instanceof StackError
            ? error.exitCode
            : exitCodeForError(axiError),
      };
    },
    resolveContext: ({ args }) => {
      const { repoFlag, hostFlag } = parseRepoContextArgs(args);
      // Explicit --hostname wins over the GITLAB_HOST env var. Setting
      // GITLAB_HOST here means the child `glab` process (which inherits
      // process.env) targets the configured host, and resolveHost() reflects it
      // for URL parsing/building. When no --hostname is given we leave
      // GITLAB_HOST untouched, so default and env-only behavior stay unchanged.
      if (hostFlag !== undefined) {
        process.env["GITLAB_HOST"] = hostFlag;
      }
      const repo = resolveRepo(repoFlag);
      const host = resolveHostContext(hostFlag);
      if (repo && host) {
        return { ...repo, host };
      }
      return repo ?? (host ? { host } : undefined);
    },
  });
}

function withRepoContext(handler: CommandFn): WrappedCommandFn {
  return (args, ctx) =>
    withSuggestionHost(ctx?.host, () =>
      handler(parseRepoContextArgs(args).strippedArgs, repoContext(ctx)),
    );
}

function withLocalRepoContext(handler: CommandFn): WrappedCommandFn {
  return (args, ctx) => {
    const parsed = parseRepoContextArgs(args);
    if (parsed.repoFlag !== undefined || process.env["GITLAB_REPO"]) {
      throw new AxiError(
        "stack commands operate on the repository in the current working directory and do not support -R, --repo, or GITLAB_REPO",
        "VALIDATION_ERROR",
      );
    }
    return withSuggestionHost(ctx?.host, () => handler(parsed.strippedArgs));
  };
}

function repoContext(ctx?: CliContext): RepoContext | undefined {
  return ctx && "fullPath" in ctx ? ctx : undefined;
}

function resolveHostContext(
  hostFlag: string | undefined,
): HostContext | undefined {
  if (hostFlag === undefined) {
    return undefined;
  }
  return { value: resolveHost(hostFlag), source: "flag" };
}

export function parseRepoContextArgs(args: string[]): {
  repoFlag: string | undefined;
  hostFlag: string | undefined;
  strippedArgs: string[];
} {
  const stripped: string[] = [];
  let repoFlag: string | undefined;
  let hostFlag: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "-R" || arg === "--repo") && index + 1 < args.length) {
      repoFlag = args[index + 1];
      index++;
      continue;
    }

    if (arg.startsWith("-R=") && arg.length > "-R=".length) {
      repoFlag = arg.slice("-R=".length);
      continue;
    }

    if (arg.startsWith("--repo=") && arg.length > "--repo=".length) {
      repoFlag = arg.slice("--repo=".length);
      continue;
    }

    // --hostname routes to GITLAB_HOST for the child glab process; it is never
    // a subcommand flag, so strip it for every command.
    if (arg === "--hostname" && index + 1 < args.length) {
      hostFlag = args[index + 1];
      index++;
      continue;
    }

    if (arg.startsWith("--hostname=") && arg.length > "--hostname=".length) {
      hostFlag = arg.slice("--hostname=".length);
      continue;
    }

    stripped.push(arg);
  }

  return { repoFlag, hostFlag, strippedArgs: stripped };
}
