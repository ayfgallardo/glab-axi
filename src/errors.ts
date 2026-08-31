import { AxiError, exitCodeForError } from "axi-sdk-js";

export type ErrorCode =
  | "REPO_NOT_FOUND"
  | "NOT_FOUND"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "GLAB_NOT_INSTALLED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

export class StackError extends AxiError {
  constructor(
    message: string,
    readonly exitCode: number,
    suggestions: string[] = [],
  ) {
    super(message, "STACK_ERROR", suggestions);
    this.name = "StackError";
  }
}

interface ErrorPattern {
  pattern: RegExp;
  code: ErrorCode;
  message: (match: RegExpMatchArray, stderr: string) => string;
  suggestions?: (match: RegExpMatchArray) => string[];
}

const patterns: ErrorPattern[] = [
  {
    // glab returns this for an unknown project OR one the token cannot see, and
    // it must sit ahead of the bare 404 pattern below.
    pattern: /404 (?:Project|Group) Not Found/i,
    code: "REPO_NOT_FOUND",
    message: (m) =>
      `${m[0].replace(/404 /, "")} — check the path or your access`,
    suggestions: () => [
      "Pass the project explicitly: `-R <namespace>/<project>` (after the command)",
      "Run `glab-axi repo list` to see the projects you can reach",
    ],
  },
  {
    pattern: /\b404\b/,
    code: "NOT_FOUND",
    message: (_m, stderr) => firstErrorLine(stderr),
  },
  {
    pattern: /could not authenticate to one or more of the configured GitLab/i,
    code: "AUTH_REQUIRED",
    message: () => "GitLab auth required — no usable token for this host",
    suggestions: () => [
      "Run `glab auth login` (or set GITLAB_TOKEN)",
      "Then verify with `glab auth status`",
    ],
  },
  {
    pattern: /\b401\b|\bUnauthorized\b/i,
    code: "AUTH_REQUIRED",
    message: () => "GitLab auth required — run `glab auth login` first",
    suggestions: () => [
      "Run `glab auth login` (or set GITLAB_TOKEN)",
      "Then verify with `glab auth status`",
    ],
  },
  {
    pattern: /\b429\b|Too Many Requests|Retry later/i,
    code: "RATE_LIMITED",
    message: () => "GitLab rate limit hit — wait and retry",
    suggestions: () => [
      "Wait ~60s before retrying",
      "Reduce concurrent requests, or use a token with a higher limit",
    ],
  },
  {
    pattern: /\b403\b|\bForbidden\b/i,
    code: "FORBIDDEN",
    message: () => "Insufficient permissions for this action",
    suggestions: () => [
      "Check your role on the project (Developer or above for most writes)",
      "For a token, check its scopes with `glab auth status`",
    ],
  },
  {
    pattern: /\b(?:400|422)\b/,
    code: "VALIDATION_ERROR",
    message: (_m, stderr) => apiMessage(stderr) ?? "Validation error",
  },
];

/**
 * glab renders command errors inside a padded box whose first lines are blank
 * and an `ERROR` banner, and prefixes `glab: ` on API failures. Strip all of
 * that so patterns and reported messages see the actual error text.
 */
function cleanLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^glab: /, "")
        .replace(/^[Xx] /, ""),
    )
    .filter((line) => line.length > 0 && line !== "ERROR");
}

function firstErrorLine(stderr: string): string {
  return cleanLines(stderr)[0] ?? "";
}

function apiMessage(stderr: string): string | undefined {
  const match = stderr.match(/"message"\s*:\s*"([^"]+)"/);
  return match ? match[1] : undefined;
}

export function mapGlabError(stderr: string, exitCode: number): AxiError {
  const cleaned = cleanLines(stderr).join("\n");

  for (const { pattern, code, message, suggestions } of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return new AxiError(
        message(match, stderr),
        code,
        suggestions?.(match) ?? [],
      );
    }
  }

  if (/not found/i.test(cleaned)) {
    return new AxiError(firstErrorLine(stderr), "NOT_FOUND");
  }

  return new AxiError(
    firstErrorLine(stderr) || `glab exited with code ${exitCode}`,
    "UNKNOWN",
  );
}

export function glabNotInstalledError(): AxiError {
  return new AxiError(
    "glab CLI is not installed — see https://gitlab.com/gitlab-org/cli",
    "GLAB_NOT_INSTALLED",
  );
}
