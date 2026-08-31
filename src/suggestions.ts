import type { RepoContext } from "./context.js";
import { DEFAULT_HOST, type HostContext } from "./host.js";
import { isCancelNoop, isWatchTerminal } from "./pipelineStatus.js";

interface SuggestionContext {
  domain: string;
  action: string;
  state?: string;
  isEmpty?: boolean;
  /** The entity number/id/tag for substitution */
  id?: string | number;
  repo?: RepoContext;
  host?: HostContext;
}

type SuggestionEntry = {
  match: (ctx: SuggestionContext) => boolean;
  lines: (ctx: SuggestionContext) => string[];
};

function repoFlag(ctx: SuggestionContext): string {
  if (ctx.repo && ctx.repo.source !== "git") {
    return ` -R ${ctx.repo.fullPath}`;
  }
  return "";
}

function normalizeRepoFlagLine(line: string): string {
  return line.replace(
    /`glab-axi -R ([^`\s]+) ([^`]+)`/g,
    "`glab-axi $2 -R $1`",
  );
}

let activeHost: HostContext | undefined;

export async function withSuggestionHost<T>(
  host: HostContext | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const previousHost = activeHost;
  activeHost = host;
  try {
    return await callback();
  } finally {
    activeHost = previousHost;
  }
}

function hostnameFlag(ctx: SuggestionContext): string {
  const host = ctx.host ?? ctx.repo?.host ?? activeHost;
  if (!host || host.source !== "flag" || host.value === DEFAULT_HOST) {
    return "";
  }
  return ` --hostname ${host.value}`;
}

function appendHostnameFlag(line: string, ctx: SuggestionContext): string {
  const flag = hostnameFlag(ctx);
  if (!flag) {
    return line;
  }
  return line.replace(/`([^`]*\bglab-axi\b[^`]*)`/g, `\`$1${flag}\``);
}

const table: SuggestionEntry[] = [
  // Home
  {
    match: (c) => c.domain === "home",
    lines: () => [
      `Run \`glab-axi <command> <subcommand>\` — commands: issue, mr, ci, schedule, release, repo, label, variable`,
    ],
  },

  // Issue list
  {
    match: (c) => c.domain === "issue" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view <iid>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} issue create --title "..." --body-file <path>\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue create --title "..." --body-file <path>\` to create an issue`,
      `Run \`glab-axi${repoFlag(c)} issue list --state closed\` to see closed issues`,
    ],
  },

  // Issue view
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "open",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue comment ${c.id} --body-file <path>\` to comment`,
      `Run \`glab-axi${repoFlag(c)} issue close ${c.id}\` to close`,
      `Run \`glab-axi${repoFlag(c)} issue edit ${c.id} --add-assignee <user>\` to assign`,
      `Run \`glab-axi search prs "${c.id}"${c.repo ? ` --repo ${c.repo.fullPath}` : ""}\` to find PRs referencing this issue`,
    ],
  },
  {
    match: (c) =>
      c.domain === "issue" && c.action === "view" && c.state === "closed",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue reopen ${c.id}\` to reopen`,
      `Run \`glab-axi${repoFlag(c)} issue comment ${c.id} --body-file <path>\` to comment`,
      `Run \`glab-axi search prs "${c.id}"${c.repo ? ` --repo ${c.repo.fullPath}` : ""}\` to find PRs referencing this issue`,
    ],
  },

  // Issue create
  {
    match: (c) => c.domain === "issue" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see the full issue`,
      `Run \`glab-axi${repoFlag(c)} issue edit ${c.id} --add-label <label>\` to label`,
    ],
  },

  // Issue close
  {
    match: (c) => c.domain === "issue" && c.action === "close",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue reopen ${c.id}\` to reopen`,
    ],
  },

  // Issue reopen
  {
    match: (c) => c.domain === "issue" && c.action === "reopen",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue close ${c.id}\` to close`,
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see details`,
    ],
  },

  // Issue edit
  {
    match: (c) => c.domain === "issue" && c.action === "edit",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see updated issue`,
    ],
  },

  // Issue comment
  {
    match: (c) => c.domain === "issue" && c.action === "comment",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id} --comments\` to see all comments`,
    ],
  },

  // Issue delete
  {
    match: (c) => c.domain === "issue" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue list\` to see remaining issues`,
    ],
  },

  // Issue lock/unlock
  {
    match: (c) => c.domain === "issue" && ["lock", "unlock"].includes(c.action),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue view ${c.id}\` to see issue details`,
    ],
  },

  // MR list
  {
    match: (c) => c.domain === "mr" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view <iid>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} mr create --title "..." --body-file <path>\` to create`,
    ],
  },
  {
    match: (c) =>
      c.domain === "mr" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr create --title "..." --body-file <path>\` to create a merge request`,
      `Run \`glab-axi${repoFlag(c)} mr list --state merged\` to see merged merge requests`,
    ],
  },

  // MR create
  {
    match: (c) => c.domain === "mr" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id}\` to see the full merge request`,
      `Run \`glab-axi${repoFlag(c)} ci status\` to monitor the pipeline`,
    ],
  },

  // MR close
  {
    match: (c) => c.domain === "mr" && c.action === "close",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr reopen ${c.id}\` to reopen`,
    ],
  },

  // MR merge
  {
    match: (c) => c.domain === "mr" && c.action === "merge",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci list\` to see the pipeline on the target branch`,
    ],
  },

  // MR review
  {
    match: (c) => c.domain === "mr" && c.action === "review",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --reviews\` to see approvals`,
    ],
  },

  // MR checks
  {
    match: (c) => c.domain === "mr" && c.action === "checks",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id}\` to see merge request details`,
      `Run \`glab-axi${repoFlag(c)} mr merge ${c.id}\` to merge when ready`,
    ],
  },

  // MR diff
  {
    match: (c) => c.domain === "mr" && c.action === "diff",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr review ${c.id} --approve\` to approve`,
    ],
  },

  // MR checkout
  {
    match: (c) => c.domain === "mr" && c.action === "checkout",
    lines: () => [],
  },

  // MR edit
  {
    match: (c) => c.domain === "mr" && c.action === "edit",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id}\` to see the updated merge request`,
    ],
  },

  // MR ready
  {
    match: (c) => c.domain === "mr" && c.action === "ready",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id}\` to see merge request status`,
    ],
  },

  // MR reopen
  {
    match: (c) => c.domain === "mr" && c.action === "reopen",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id}\` to see merge request details`,
    ],
  },

  // MR comment
  {
    match: (c) => c.domain === "mr" && c.action === "comment",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr view ${c.id} --comments\` to see all comments`,
    ],
  },

  // MR rebase
  {
    match: (c) => c.domain === "mr" && c.action === "rebase",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} mr checks ${c.id}\` to monitor the pipeline after the rebase`,
    ],
  },

  // CI list
  {
    match: (c) => c.domain === "ci" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view <id>\` to view a pipeline and its jobs`,
      `Run \`glab-axi${repoFlag(c)} ci status\` to see the pipeline of the current branch`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci run\` to trigger a pipeline`,
    ],
  },

  // CI status / view — a pipeline still in flight can be canceled, and watched
  // unless it is parked on a manual gate that will never clear on its own.
  {
    match: (c) =>
      ["status", "view"].includes(c.action) &&
      c.domain === "ci" &&
      !isCancelNoop(c.state),
    lines: (c) => [
      ...(isWatchTerminal(c.state)
        ? []
        : [
            `Run \`glab-axi${repoFlag(c)} ci watch ${c.id}\` to wait until the pipeline finishes`,
          ]),
      `Run \`glab-axi${repoFlag(c)} ci cancel ${c.id}\` to cancel it`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && c.action === "view" && c.state === "failed",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci retry ${c.id}\` to retry the failed jobs`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && c.action === "status" && c.state === "failed",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view ${c.id}\` to see every job`,
      `Run \`glab-axi${repoFlag(c)} ci retry ${c.id}\` to retry the failed jobs`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "status",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view ${c.id}\` to see every job`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "view",
    lines: () => [],
  },

  // CI run/retry/watch/cancel
  {
    match: (c) =>
      c.domain === "ci" && ["run", "retry"].includes(c.action) && !!c.id,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci watch ${c.id}\` to wait until it finishes`,
    ],
  },
  {
    match: (c) => c.domain === "ci" && c.action === "run",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci status\` to follow the new pipeline`,
    ],
  },
  {
    match: (c) =>
      c.domain === "ci" && ["watch", "cancel", "retry"].includes(c.action),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci view ${c.id}\` to see the job breakdown`,
    ],
  },

  // Schedule list
  {
    match: (c) => c.domain === "schedule" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} schedule view <id>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} schedule run <id>\` to run one now`,
    ],
  },
  {
    match: (c) =>
      c.domain === "schedule" && c.action === "list" && c.isEmpty === true,
    lines: () => [],
  },

  // Schedule view
  {
    match: (c) => c.domain === "schedule" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} schedule run ${c.id}\` to run it now`,
    ],
  },

  // Schedule run
  {
    match: (c) => c.domain === "schedule" && c.action === "run",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} ci list --source schedule\` to see the pipeline it started`,
    ],
  },

  // Schedule enable/disable
  {
    match: (c) =>
      c.domain === "schedule" && ["enable", "disable"].includes(c.action),
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} schedule list\` to see all schedules`,
    ],
  },

  // Release list
  {
    match: (c) => c.domain === "release" && c.action === "list",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view <tag>\` to view details`,
      `Run \`glab-axi${repoFlag(c)} release create <tag> --body-file <path>\` to create a release`,
    ],
  },

  // Release view
  {
    match: (c) => c.domain === "release" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release download ${c.id}\` to download assets`,
      `Run \`glab-axi${repoFlag(c)} release edit ${c.id} --body-file <path>\` to edit notes`,
    ],
  },

  // Release create
  {
    match: (c) => c.domain === "release" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view ${c.id}\` to view the release`,
      `Run \`glab-axi${repoFlag(c)} release upload ${c.id} <files...>\` to upload assets`,
    ],
  },

  // Release edit/delete
  {
    match: (c) => c.domain === "release" && c.action === "edit",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view ${c.id}\` to see updated release`,
    ],
  },
  {
    match: (c) => c.domain === "release" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release list\` to see remaining releases`,
    ],
  },

  // Release download/upload
  {
    match: (c) => c.domain === "release" && c.action === "download",
    lines: () => [],
  },
  {
    match: (c) => c.domain === "release" && c.action === "upload",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} release view ${c.id}\` to see all assets`,
    ],
  },

  // Repo view
  {
    match: (c) => c.domain === "repo" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} issue list\` to see issues`,
      `Run \`glab-axi${repoFlag(c)} mr list\` to see merge requests`,
    ],
  },

  // Repo create
  {
    match: (c) => c.domain === "repo" && c.action === "create",
    lines: () => [],
  },

  // Repo list
  {
    match: (c) => c.domain === "repo" && c.action === "list",
    lines: () => [
      `Run \`glab-axi repo view --repo <owner/name>\` to view a repository`,
    ],
  },

  // Repo edit/clone/fork
  {
    match: (c) =>
      c.domain === "repo" && ["edit", "clone", "fork"].includes(c.action),
    lines: () => [],
  },

  // Label list
  {
    match: (c) => c.domain === "label" && c.action === "list",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label create --name "..." --color "..."\` to create a label`,
    ],
  },

  // Label create/edit/delete
  {
    match: (c) => c.domain === "label" && c.action === "create",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label list\` to see all labels`,
    ],
  },
  {
    match: (c) => c.domain === "label" && c.action === "edit",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label list\` to see all labels`,
    ],
  },
  {
    match: (c) => c.domain === "label" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} label list\` to see remaining labels`,
    ],
  },

  // Variable list
  {
    match: (c) => c.domain === "variable" && c.action === "list" && !c.isEmpty,
    lines: (c) => [
      `Run \`echo -n "<value>" | glab-axi variable set <name>${repoFlag(c)}\` to add or update a variable`,
    ],
  },
  {
    match: (c) =>
      c.domain === "variable" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`echo -n "<value>" | glab-axi variable set <name>${repoFlag(c)}\` to add a variable`,
    ],
  },

  // Variable get/set/delete
  {
    match: (c) => c.domain === "variable" && c.action === "get",
    lines: (c) => [
      `Run \`glab-axi variable list${repoFlag(c)}\` to see all variables`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "set",
    lines: (c) => [
      `Run \`glab-axi variable list${repoFlag(c)}\` to see all variables`,
    ],
  },
  {
    match: (c) => c.domain === "variable" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi variable list${repoFlag(c)}\` to see remaining variables`,
    ],
  },

  // Snippet list
  {
    match: (c) => c.domain === "snippet" && c.action === "list" && !c.isEmpty,
    lines: () => [
      "Run `glab-axi snippet view <id>` to view a snippet's files and metadata",
      "Run `glab-axi snippet list --personal` to see personal snippets",
    ],
  },
  {
    match: (c) =>
      c.domain === "snippet" && c.action === "list" && c.isEmpty === true,
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} snippet create --title "..." <file>\` to create a snippet`,
    ],
  },

  // Snippet view
  {
    match: (c) => c.domain === "snippet" && c.action === "view",
    lines: (c) => [
      `Run \`glab-axi snippet view ${String(c.id)} --files\` to list file names only`,
      `Run \`glab-axi${repoFlag(c)} snippet list\` to see all snippets`,
    ],
  },

  // Snippet create
  {
    match: (c) => c.domain === "snippet" && c.action === "create",
    lines: (c) => [`Run \`glab-axi snippet view ${String(c.id)}\` to see it`],
  },

  // Snippet edit
  {
    match: (c) => c.domain === "snippet" && c.action === "edit",
    lines: (c) => [
      `Run \`glab-axi snippet view ${String(c.id)}\` to see the updated snippet`,
    ],
  },

  // Snippet delete
  {
    match: (c) => c.domain === "snippet" && c.action === "delete",
    lines: (c) => [
      `Run \`glab-axi${repoFlag(c)} snippet list\` to see remaining snippets`,
    ],
  },

  // API
  {
    match: (c) => c.domain === "api",
    lines: () => [],
  },

  // Stack
  {
    match: (c) => c.domain === "stack",
    lines: () => [],
  },
];

export function getSuggestions(ctx: SuggestionContext): string[] {
  for (const entry of table) {
    if (entry.match(ctx)) {
      return entry
        .lines(ctx)
        .map(normalizeRepoFlagLine)
        .map((line) => appendHostnameFlag(line, ctx));
    }
  }
  return [];
}
