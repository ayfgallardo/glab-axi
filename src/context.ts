import { execFileSync } from "node:child_process";
import { escapeRegExp, resolveHost, type HostContext } from "./host.js";

export interface RepoContext {
  /** Full "NAMESPACE/PROJECT" path; the namespace may itself be nested. */
  fullPath: string;
  /** How the project was resolved — determines whether to append -R to glab calls */
  source: "flag" | "env" | "git";
  host?: HostContext;
}

/**
 * Resolve the target project.
 * Priority: --repo flag > GITLAB_REPO env > git remote origin.
 */
export function resolveRepo(flagValue?: string): RepoContext | undefined {
  if (flagValue) {
    return parseFullPath(flagValue, "flag");
  }

  const envRepo = process.env["GITLAB_REPO"];
  if (envRepo) {
    return parseFullPath(envRepo, "env");
  }

  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseRemoteUrl(url);
  } catch {
    return undefined;
  }
}

/** The checked-out branch, or undefined outside a repo and on a detached HEAD. */
export function resolveCurrentBranch(): string | undefined {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/** The `:id` a GitLab REST path expects: the project path, URL-encoded. */
export function encodedProjectId(ctx: RepoContext): string {
  return encodeURIComponent(ctx.fullPath);
}

function parseFullPath(
  fullPath: string,
  source: "flag" | "env" | "git",
): RepoContext | undefined {
  const parts = fullPath.split("/");
  if (parts.length < 2 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  return { fullPath, source };
}

function parseRemoteUrl(url: string): RepoContext | undefined {
  // Match against the configured host (defaults to gitlab.com), so remotes on a
  // self-managed instance such as git.example.com resolve too.
  const host = escapeRegExp(resolveHost());
  // SSH: git@<host>:NAMESPACE/PROJECT.git — HTTPS: https://<host>/NAMESPACE/PROJECT.git
  const match = url.match(new RegExp(`(?:^|@|/)${host}[:/](.+?)(?:\\.git)?$`));
  if (!match) return undefined;
  return parseFullPath(match[1], "git");
}
