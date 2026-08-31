import { AxiError } from "./errors.js";
import { readStdin, isStdinTTY } from "./stdin.js";

function valueRequiredError(noun: "secret" | "variable"): AxiError {
  return new AxiError(
    `${noun} value is required: pipe the value via stdin`,
    "VALIDATION_ERROR",
    [`echo -n "<value>" | glab-axi ${noun} set <name>`],
  );
}

/**
 * Resolve a secret/variable value from piped stdin only.
 * `flagValue` exists for callers that already extracted a flag value from
 * their own args before calling in; glab-axi never wires one up for either
 * noun, since a secret or variable value must never reach child-process
 * argv — passing one is rejected rather than silently accepted.
 * Never accepts an interactive TTY prompt.
 */
export async function resolveValue(
  flagValue: string | undefined,
  noun: "secret" | "variable",
): Promise<string> {
  if (flagValue !== undefined) {
    throw new AxiError(
      `${noun} values must be piped via stdin; a flag value is not accepted`,
      "VALIDATION_ERROR",
      [`echo -n "<value>" | glab-axi ${noun} set <name>`],
    );
  }

  if (isStdinTTY()) {
    throw valueRequiredError(noun);
  }

  const value = await readStdin();
  if (value.length === 0) {
    throw valueRequiredError(noun);
  }
  return value;
}
