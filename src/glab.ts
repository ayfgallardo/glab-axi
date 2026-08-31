import { execFile } from "node:child_process";
import { encodedProjectId, type RepoContext } from "./context.js";
import { AxiError, glabNotInstalledError, mapGlabError } from "./errors.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ApiOptions {
  ctx?: RepoContext;
  method?: string;
  fields?: Record<string, string | number | boolean>;
}

function buildArgs(args: string[], ctx?: RepoContext): string[] {
  const out = [...args];
  // Append -R for flag/env sources (git remote is auto-detected by glab)
  if (ctx && ctx.source !== "git") {
    out.push("-R", ctx.fullPath);
  }
  return out;
}

const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function execOptions(ctx?: RepoContext) {
  return {
    maxBuffer: MAX_BUFFER_BYTES,
    ...(ctx?.host
      ? { env: { ...process.env, GITLAB_HOST: ctx.host.value } }
      : {}),
  };
}

function toExecResult(
  resolve: (result: ExecResult) => void,
): (error: Error | null, stdout: string, stderr: string) => void {
  return (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      resolve({ stdout: "", stderr: "ENOENT", exitCode: 127 });
      return;
    }
    const exitCode = error
      ? ((error as Error & { code?: string | number }).code ?? 1)
      : 0;
    resolve({
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: typeof exitCode === "number" ? exitCode : 1,
    });
  };
}

function run(args: string[], ctx?: RepoContext): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile("glab", args, execOptions(ctx), toExecResult(resolve));
  });
}

/** Run glab, writing `input` to the child process's stdin instead of the CLI's own. */
function runWithStdin(
  args: string[],
  input: string,
  ctx?: RepoContext,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "glab",
      args,
      execOptions(ctx),
      toExecResult(resolve),
    );
    child.stdin?.end(input);
  });
}

function parseJson<T>(result: ExecResult): T {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new AxiError(
      `Unexpected glab output: ${result.stdout.slice(0, 200)}`,
      "UNKNOWN",
    );
  }
}

function throwOnFailure(result: ExecResult): void {
  if (result.stderr === "ENOENT") throw glabNotInstalledError();
  if (result.exitCode !== 0) throw mapGlabError(result.stderr, result.exitCode);
}

/** Execute glab and return parsed JSON. */
export async function glabJson<T = unknown>(
  args: string[],
  ctx?: RepoContext,
): Promise<T> {
  const result = await run(buildArgs(args, ctx), ctx);
  throwOnFailure(result);
  return parseJson<T>(result);
}

/** Execute glab and return raw stdout. */
export async function glabExec(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const result = await run(buildArgs(args, ctx), ctx);
  throwOnFailure(result);
  return result.stdout;
}

/** Execute glab, returning stdout + stderr without throwing on non-zero exit. */
export async function glabRaw(
  args: string[],
  ctx?: RepoContext,
): Promise<ExecResult> {
  const result = await run(buildArgs(args, ctx), ctx);
  if (result.stderr === "ENOENT") throw glabNotInstalledError();
  return result;
}

/**
 * Execute glab, writing `input` to the child's stdin instead of a CLI flag.
 * Keeps sensitive values (variable bodies) out of the argv glab receives.
 */
export async function glabExecWithStdin(
  args: string[],
  input: string,
  ctx?: RepoContext,
): Promise<string> {
  const result = await runWithStdin(buildArgs(args, ctx), input, ctx);
  throwOnFailure(result);
  return result.stdout;
}

/**
 * Call the GitLab REST API through `glab api`.
 *
 * `glab api` has no -R flag: the target project travels inside the path, as the
 * URL-encoded `:id`. glab only resolves that placeholder from the current
 * checkout, so an explicit context must be substituted here instead.
 */
export async function glabApiJson<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const { ctx, method, fields } = opts;
  const args = [
    "api",
    ctx ? path.replaceAll(":id", encodedProjectId(ctx)) : path,
  ];

  if (method) {
    args.push("--method", method);
  }
  for (const [key, value] of Object.entries(fields ?? {})) {
    // --raw-field keeps a string a string; --field infers booleans and numbers.
    args.push(
      typeof value === "string" ? "--raw-field" : "--field",
      `${key}=${value}`,
    );
  }

  const result = await run(args, ctx);
  throwOnFailure(result);
  return parseJson<T>(result);
}
