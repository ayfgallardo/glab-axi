import { execFile } from "node:child_process";
import { encodedProjectId, type RepoContext } from "./context.js";
import { AxiError, glabNotInstalledError, mapGlabError } from "./errors.js";
import { recordRawBody } from "./gain.js";

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

/**
 * `glab api` is the only invocation whose stdout is a GitLab API response body;
 * every other subcommand emits glab's own rendering. Recording here — the one
 * callback both `run` and `runWithStdin` resolve through — counts each response
 * exactly once, `--paginate` included (glab concatenates the pages into a
 * single stdout). A failed call answers on stderr instead, and stays counted:
 * this module has no retry or auth-fallback path, so an error body is always
 * one an agent would have read.
 */
function recordApiBody(args: string[], result: ExecResult): void {
  if (args[0] === "api") {
    recordRawBody(result.stdout || result.stderr);
  }
}

function toExecResult(
  args: string[],
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
    const result: ExecResult = {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: typeof exitCode === "number" ? exitCode : 1,
    };
    recordApiBody(args, result);
    resolve(result);
  };
}

function run(args: string[], ctx?: RepoContext): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "glab",
      args,
      execOptions(ctx),
      toExecResult(args, resolve),
    );
    // Close the child's stdin immediately: this call path never has input to
    // send, and execFile otherwise leaves stdin open. If glab ever prompts
    // interactively (e.g. `glab stack sync` asking fork vs. upstream), an
    // open, never-written, never-closed stdin makes it hang forever waiting
    // for EOF instead of failing — an immediate close turns any such prompt
    // into glab's own immediate non-interactive error, with its exit code
    // surfaced normally through toExecResult/mapGlabError.
    child.stdin?.end();
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
      toExecResult(args, resolve),
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
  const result = await runApi(path, opts);
  return parseJson<T>(result);
}

/**
 * Call a GitLab REST endpoint that answers with plain text rather than JSON,
 * such as a job log (`/jobs/:job_id/trace`).
 */
export async function glabApiText(
  path: string,
  opts: ApiOptions = {},
): Promise<string> {
  const result = await runApi(path, opts);
  return result.stdout;
}

export interface ApiBodyOptions {
  ctx?: RepoContext;
  method?: string;
}

/**
 * Call the GitLab REST API with a JSON request body piped via `--input -`.
 *
 * `glab api --raw-field`/`--field` serialize each key literally, so a nested
 * key like `files[0][file_path]` becomes the JSON property name
 * `"files[0][file_path]"` instead of a nested array — GitLab then reports the
 * array as missing. Piping a real JSON body on stdin is the only way `glab
 * api` can express nested objects or arrays.
 */
export async function glabApiJsonBody<T = unknown>(
  path: string,
  body: unknown,
  opts: ApiBodyOptions = {},
): Promise<T> {
  const { ctx, method = "POST" } = opts;
  const args = [
    "api",
    ctx ? path.replaceAll(":id", encodedProjectId(ctx)) : path,
    "--method",
    method,
    "--input",
    "-",
  ];
  const result = await runWithStdin(args, JSON.stringify(body), ctx);
  throwOnFailure(result);
  return parseJson<T>(result);
}

async function runApi(path: string, opts: ApiOptions): Promise<ExecResult> {
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
  return result;
}
