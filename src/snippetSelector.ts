import { AxiError } from "./errors.js";
import { resolveHost } from "./host.js";

/**
 * Convert a bare snippet id or a snippet URL to a bare numeric id.
 *
 * Accepts two URL shapes:
 *   <host>/<namespace>/<project>/-/snippets/<id>  (project snippet)
 *   <host>/-/snippets/<id>                        (personal snippet)
 *
 * Both shapes end in the numeric id as the last path segment, so taking the
 * last non-empty segment handles them uniformly.
 *
 * The URL's host is validated against the configured host (GITLAB_HOST >
 * gitlab.com).
 */
export function snippetIdFromSelector(selector: string): string {
  const trimmed = selector.trim();

  if (!trimmed) {
    throw new AxiError(
      "Snippet selector must not be empty",
      "VALIDATION_ERROR",
    );
  }

  if (/\s/.test(trimmed)) {
    throw new AxiError(
      `Snippet selector must not contain whitespace: "${trimmed}"`,
      "VALIDATION_ERROR",
    );
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return extractIdFromUrl(trimmed);
  }

  return validateBareId(trimmed);
}

// A GitLab snippet id is numeric. Reject anything else (slashes, dot-segments,
// etc.) that could alter the API path it gets interpolated into.
function validateBareId(id: string): string {
  if (!/^\d+$/.test(id)) {
    throw new AxiError(`Invalid snippet id: "${id}"`, "VALIDATION_ERROR", [
      "A snippet id is numeric; pass a bare id or a full snippet URL",
    ]);
  }
  return id;
}

function extractIdFromUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AxiError(`Malformed snippet URL: ${rawUrl}`, "VALIDATION_ERROR");
  }

  const configured = resolveHost();
  if (url.hostname !== configured) {
    throw new AxiError(
      `Snippet URL host "${url.hostname}" does not match the configured host "${configured}"`,
      "VALIDATION_ERROR",
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id) {
    throw new AxiError(
      `Could not extract a snippet id from URL: ${rawUrl}`,
      "VALIDATION_ERROR",
    );
  }

  return validateBareId(id);
}
