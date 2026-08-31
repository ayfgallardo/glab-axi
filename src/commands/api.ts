import { encode } from "@toon-format/toon";
import type { RepoContext } from "../context.js";
import { glabExec, glabExecWithStdin } from "../glab.js";
import { AxiError } from "../errors.js";
import { readStdin, isStdinTTY } from "../stdin.js";

export const API_HELP = `usage: glab-axi api [<method>] <path>
description: Make an authenticated GitLab API request (REST v4 or GraphQL). Defaults to GET.
methods[6]:
  GET, POST, PUT, PATCH, DELETE, HEAD
flags[6]:
  -X <method> or -X=<method> (alias for the positional method; give once and do not combine with a positional method), --field <key=value> (repeatable, type-inferred), --raw-field <key=value> (repeatable, string), --header <key:value> (repeatable), --input <file> (raw request body; use "-" for stdin), --paginate, --full (preserve complete field values without truncation)
notes:
  Path is a GitLab REST v4 path (e.g. projects/:id/issues) or the literal "graphql".
  gh's --jq and --template have no glab equivalent and are not accepted; pipe to jq instead.
examples:
  glab-axi api projects/:id/issues
  glab-axi api POST projects/:id/issues --field title="Bug report"
  glab-axi api -X POST projects/:id/issues --field title="Bug report"
  glab-axi api projects/:id/merge_requests --paginate
  glab-axi api graphql --raw-field query='query { currentUser { username } }'
  glab-axi api PUT projects/:id/variables/FOO --raw-field value=bar
  cat body.json | glab-axi api PUT projects/:id/variables/FOO --input -`;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** The glab short flag for HTTP method, equivalent to the positional method. */
const METHOD_FLAG = "-X";

/** Value flags that may be given more than once, each occurrence forwarded to glab. */
const REPEATABLE_VALUE_FLAGS = new Set(["--field", "--raw-field", "--header"]);

/** Value flags glab accepts only one of, so a repeat is a caller mistake. */
const SINGLE_VALUE_FLAGS = new Set(["--input"]);

/** Flags that stand alone and must not consume the following argument, and are forwarded to glab. */
const BOOL_FLAGS = new Set(["--paginate"]);

/** Flags that stand alone, are glab-axi-only, and must not be forwarded to glab. */
const LOCAL_BOOL_FLAGS = new Set(["--full"]);

const SUPPORTED_FLAGS = [
  METHOD_FLAG,
  ...REPEATABLE_VALUE_FLAGS,
  ...SINGLE_VALUE_FLAGS,
  ...BOOL_FLAGS,
  ...LOCAL_BOOL_FLAGS,
];

/** The flag's name without any `=value` suffix, so errors never echo a value. */
function flagName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}

interface ParsedApiArgs {
  positionals: string[];
  fields: string[];
  rawFields: string[];
  headers: string[];
  method?: string;
  input?: string;
  paginate: boolean;
  full: boolean;
}

/**
 * Walk args once, collecting positionals and flag values and rejecting anything
 * unrecognised. Only flags known to take a value consume the next argument, so
 * an unimplemented flag can never silently swallow the following argument.
 */
function parseArgs(args: string[]): ParsedApiArgs {
  const parsed: ParsedApiArgs = {
    positionals: [],
    fields: [],
    rawFields: [],
    headers: [],
    paginate: false,
    full: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
      continue;
    }
    const name = flagName(arg);
    if (BOOL_FLAGS.has(name)) {
      if (name !== arg)
        throw new AxiError(`${name} does not take a value`, "VALIDATION_ERROR");
      parsed.paginate = true;
      continue;
    }
    if (LOCAL_BOOL_FLAGS.has(name)) {
      if (name !== arg)
        throw new AxiError(`${name} does not take a value`, "VALIDATION_ERROR");
      parsed.full = true;
      continue;
    }
    if (
      name !== METHOD_FLAG &&
      !REPEATABLE_VALUE_FLAGS.has(name) &&
      !SINGLE_VALUE_FLAGS.has(name)
    ) {
      throw new AxiError(
        `unknown flag ${name} for glab-axi api. Supported flags: ${SUPPORTED_FLAGS.join(", ")}`,
        "VALIDATION_ERROR",
      );
    }
    let value: string;
    if (name === arg) {
      const next = args[i + 1];
      if (
        next === undefined ||
        (name === "--input" && SUPPORTED_FLAGS.includes(flagName(next)))
      )
        throw new AxiError(`${name} requires a value`, "VALIDATION_ERROR");
      value = next;
      i++;
    } else {
      value = arg.slice(name.length + 1);
    }
    if (name === METHOD_FLAG) {
      if (parsed.method !== undefined)
        throw new AxiError(
          `${name} may only be given once`,
          "VALIDATION_ERROR",
        );
      const upper = value.toUpperCase();
      if (!HTTP_METHODS.has(upper)) {
        throw new AxiError(
          `${name} ${value} is not a supported HTTP method. Supported: ${[...HTTP_METHODS].join(", ")}`,
          "VALIDATION_ERROR",
        );
      }
      parsed.method = upper;
    } else if (name === "--field") {
      parsed.fields.push(value);
    } else if (name === "--raw-field") {
      parsed.rawFields.push(value);
    } else if (name === "--header") {
      parsed.headers.push(value);
    } else {
      if (parsed.input !== undefined)
        throw new AxiError(
          `${name} may only be given once`,
          "VALIDATION_ERROR",
        );
      parsed.input = value;
    }
  }
  return parsed;
}

/** Maximum length for raw (non-JSON) API output before truncation. */
const RAW_OUTPUT_TRUNCATION_LIMIT = 4000;

/** Maximum length for a string value before truncation. */
const STRING_VALUE_TRUNCATION_LIMIT = 2000;

export async function apiCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  if (args[0] === "--help" || args.length === 0) return API_HELP;

  const {
    positionals,
    fields,
    rawFields,
    headers,
    method: methodFlag,
    input,
    paginate,
    full,
  } = parseArgs(args);

  const pathRequired = new AxiError(
    "API path is required: glab-axi api [<method>] <path>",
    "VALIDATION_ERROR",
  );
  if (positionals.length === 0) throw pathRequired;

  const methodGiven = HTTP_METHODS.has(positionals[0].toUpperCase());
  if (methodFlag !== undefined && methodGiven) {
    throw new AxiError(
      "method given twice: use either -X <method> or the positional method, not both",
      "VALIDATION_ERROR",
    );
  }
  if (positionals.length > (methodGiven ? 2 : 1)) {
    throw new AxiError(
      "too many arguments for glab-axi api: expected [<method>] <path>",
      "VALIDATION_ERROR",
    );
  }
  if (methodGiven && positionals.length < 2) throw pathRequired;

  const method =
    methodFlag ?? (methodGiven ? positionals[0].toUpperCase() : "GET");
  const path = methodGiven ? positionals[1] : positionals[0];

  const glabArgs = ["api", path, "--method", method];

  for (const f of fields) {
    glabArgs.push("--field", f);
  }
  for (const f of rawFields) {
    glabArgs.push("--raw-field", f);
  }
  for (const h of headers) {
    glabArgs.push("--header", h);
  }

  // `--input -` cannot be forwarded to the child `glab` process as-is: execFile
  // gives the child its own unconnected stdin pipe, so `glab` would block
  // forever waiting for bytes nothing writes. Read our own stdin instead and
  // relay it through glabExecWithStdin (still via `--input -`).
  let stdinBody: string | undefined;
  if (input === "-") {
    if (isStdinTTY())
      throw new AxiError(
        "--input - requires piped stdin (no request body to read)",
        "VALIDATION_ERROR",
      );
    stdinBody = await readStdin();
    glabArgs.push("--input", "-");
  } else if (input !== undefined) {
    glabArgs.push("--input", input);
  }

  if (paginate) glabArgs.push("--paginate");

  const raw =
    stdinBody !== undefined
      ? await glabExecWithStdin(glabArgs, stdinBody, ctx)
      : await glabExec(glabArgs, ctx);

  try {
    const data = JSON.parse(raw);
    return encode(shapeOutput(data, !full));
  } catch {
    const trimmed = raw.trim();
    const truncated = !full && trimmed.length > RAW_OUTPUT_TRUNCATION_LIMIT;
    const result: Record<string, unknown> = {
      api_response: {
        body: truncated
          ? trimmed.slice(0, RAW_OUTPUT_TRUNCATION_LIMIT)
          : trimmed,
        truncated,
      },
    };
    if (truncated) {
      (result.api_response as Record<string, unknown>).original_length =
        trimmed.length;
    }
    return encode(result);
  }
}

/** Bound a string value's length, leaving its content otherwise untouched. */
function truncateString(value: string): string {
  if (value.length <= STRING_VALUE_TRUNCATION_LIMIT) return value;
  return value.slice(0, STRING_VALUE_TRUNCATION_LIMIT) + "... (truncated)";
}

/**
 * Walk a decoded API response, bounding every string value's length. Unlike
 * gh's api.ts, this does not strip a curated noisy-key deny-list: GitLab REST
 * responses do not carry GitHub's volume of template/gravatar/permission URLs,
 * so a length clamp alone keeps output compact without guessing at fields to
 * drop. `--full` (truncateValues=false) disables even that.
 */
function shapeOutput(
  obj: unknown,
  truncateValues: boolean,
  depth = 0,
): unknown {
  if (depth > 8) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => shapeOutput(item, truncateValues, depth + 1));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = shapeOutput(value, truncateValues, depth + 1);
    }
    return result;
  }
  if (typeof obj === "string") {
    return truncateValues ? truncateString(obj) : obj;
  }
  return obj;
}
