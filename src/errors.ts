import { AxiError, exitCodeForError } from "axi-sdk-js";

export type ErrorCode =
  | "REPO_NOT_FOUND"
  | "REPO_RESOLUTION"
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

/**
 * Match an HTTP status only where glab actually prints one: at the start of an
 * error line (`404 Not Found.`), inside its `(HTTP 404)` suffix, after the
 * `: ` that follows the request URL (`GET https://…/pipelines/12: 403 {…}`),
 * or as a bare `HTTP <code>` word (the `glab: HTTP 400` form glab appends
 * after a JSON error body with no leading request URL). A bare `\b404\b`
 * would also hit a resource id inside that URL, which would misclassify
 * every other failure on issue/MR iid 400, 403, 404 or 429 — `HTTP ` stays
 * the anchor in the new case too.
 */
function httpStatus(...codes: number[]): string {
  return `(?:^|\\(HTTP |:\\s|\\bHTTP )(?:${codes.join("|")})\\b`;
}

const patterns: ErrorPattern[] = [
  {
    // glab returns this for an unknown project OR one the token cannot see, and
    // it must sit ahead of the generic 404 pattern below.
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
    // `glab mr create` (and other cwd-bound commands) refuse to run when no
    // local git remote matches the configured GITLAB_HOST — no HTTP status
    // involved, so this must sit ahead of the generic fallbacks below.
    pattern:
      /None of the git remotes configured for this repository correspond to the GITLAB_HOST/i,
    code: "REPO_RESOLUTION",
    message: (_m, stderr) => firstErrorLine(stderr),
    suggestions: () => [
      "Run from a checkout of the target project",
      "Or add a matching git remote, or fix GITLAB_HOST, so they correspond",
    ],
  },
  {
    pattern: new RegExp(httpStatus(404), "m"),
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
    pattern: new RegExp(`${httpStatus(401)}|\\bUnauthorized\\b`, "im"),
    code: "AUTH_REQUIRED",
    message: () => "GitLab auth required — run `glab auth login` first",
    suggestions: () => [
      "Run `glab auth login` (or set GITLAB_TOKEN)",
      "Then verify with `glab auth status`",
    ],
  },
  {
    pattern: new RegExp(
      `${httpStatus(429)}|Too Many Requests|Retry later`,
      "im",
    ),
    code: "RATE_LIMITED",
    message: () => "GitLab rate limit hit — wait and retry",
    suggestions: () => [
      "Wait ~60s before retrying",
      "Reduce concurrent requests, or use a token with a higher limit",
    ],
  },
  {
    pattern: new RegExp(`${httpStatus(403)}|\\bForbidden\\b`, "im"),
    code: "FORBIDDEN",
    message: () => "Insufficient permissions for this action",
    suggestions: () => [
      "Check your role on the project (Developer or above for most writes)",
      "For a token, check its scopes with `glab auth status`",
    ],
  },
  {
    pattern: new RegExp(httpStatus(400, 422), "m"),
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

/**
 * glab sometimes emits flat context lines (e.g. a recovery-file notice) before
 * its boxed ERROR banner. The box holds the actual failure reason, so prefer
 * its content — the lines between the `ERROR` banner and the box's closing
 * blank line, rejoined with spaces since glab wraps a long message across
 * several padded lines. Returns undefined when stderr has no box, so callers
 * fall back to the first cleaned line as before.
 */
function boxedMessage(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((line) => line.trim());
  const bannerIndex = lines.indexOf("ERROR");
  if (bannerIndex === -1) return undefined;

  const messageLines: string[] = [];
  for (let i = bannerIndex + 1; i < lines.length; i++) {
    if (lines[i].length === 0) {
      if (messageLines.length > 0) break;
      continue;
    }
    messageLines.push(lines[i]);
  }
  return messageLines.length > 0 ? messageLines.join(" ") : undefined;
}

function firstErrorLine(stderr: string): string {
  return boxedMessage(stderr) ?? cleanLines(stderr)[0] ?? "";
}

function apiMessage(stderr: string): string | undefined {
  const match = stderr.match(/"(?:message|error)"\s*:\s*"([^"]+)"/);
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
