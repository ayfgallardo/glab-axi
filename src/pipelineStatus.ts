/**
 * Two different notions of "this pipeline is over", deliberately not merged.
 *
 * A pipeline parked on a `manual` gate (or a `scheduled` delayed job) will not
 * advance without a human, so waiting on it is pointless — but it is still
 * running as far as GitLab is concerned, and cancelling it is legitimate.
 */
const CANCEL_NOOP_STATUSES = ["success", "failed", "canceled", "skipped"];

const WATCH_TERMINAL_STATUSES = [
  ...CANCEL_NOOP_STATUSES,
  "manual",
  "scheduled",
];

/** True when `ci cancel` has nothing left to cancel. */
export function isCancelNoop(status: string | undefined): boolean {
  return CANCEL_NOOP_STATUSES.includes(status ?? "");
}

/** True when `ci watch` must stop polling, whether or not work actually ran. */
export function isWatchTerminal(status: string | undefined): boolean {
  return WATCH_TERMINAL_STATUSES.includes(status ?? "");
}
