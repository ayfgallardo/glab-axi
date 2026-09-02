# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Port status: gh-axi → glab-axi

This repository is a **complete** port of gh-axi 0.1.35 (a `gh` wrapper) to `glab`. Every command family is ported and authoritative: `src/glab.ts`, `src/context.ts`, `src/errors.ts`, `src/host.ts`, `src/cli.ts`, `src/version.ts`, `src/args.ts`, `bin/glab-axi.ts`, `src/commands/issue.ts`, `src/commands/mr.ts`, `src/commands/ci.ts`, `src/commands/schedule.ts`, `src/commands/repo.ts`, `src/commands/label.ts`, `src/commands/release.ts`, `src/commands/variable.ts`, `src/commands/snippet.ts`, `src/commands/stack.ts`, `src/commands/api.ts`, `src/commands/setup.ts`, `src/commands/home.ts`, `src/skill.ts`, and every domain of `src/suggestions.ts`. `tsconfig.json` and `vitest.config.ts` carry no exclusions any more — the port-in-progress quarantine mechanism (a `NOT_PORTED_YET` suite list plus matching `tsconfig` file exclusions) was fully retired once the last lot (snippet/stack/api/setup) landed.

Three gh-era files were retired rather than ported, each for a reason with no straight GitLab equivalent, not for lack of effort:

- `src/commands/secret.ts` — GitLab has no `secret` resource; folded into `variable.ts`'s `set` (see "Variables" below).
- `src/commands/project.ts` and `src/commands/search.ts` — orphaned baseline-import files, never wired into `cli.ts`'s `COMMANDS`/`COMMAND_NAMES` by any port lot. GitHub Projects (v2) has no GitLab CLI equivalent (`glab` has no `project` command at all); GitLab does expose a native `glab search` (BETA), but porting gh-axi's GitHub code/issue/pr/repo search surface onto it was never requested by any task in the port plan, so it was dropped rather than half-built. `test/cli.test.ts`'s "drops the GitHub-only command families" test pins this.
- `src/totals.ts` — GitHub search-API-based filtered-count helper for `issue`/`pr` list, consumed nowhere once `mr.ts`/`issue.ts` were ported (GitLab's `X-Total` header approach is used instead, see `mr.ts` below); deleted as dead code along with `test/totals.test.ts`.

`gist.ts`/`gistSelector.ts` were renamed to `snippet.ts`/`snippetSelector.ts` in place (`git mv`), not left as a parallel file — see "Snippets" below.

## glab invocation core (`src/glab.ts`, `src/context.ts`, `src/errors.ts`)

Command modules talk to glab through `src/glab.ts` only: `glabJson`, `glabExec`, `glabRaw`, `glabExecWithStdin`, `glabApiJson`, `glabApiText` (same call as `glabApiJson` for the endpoints that answer plain text, such as a job trace). All go through `execFile("glab", …)` — never a shell.

`run()` — the internal helper behind every call _except_ `glabExecWithStdin` — closes the spawned glab process's stdin immediately (`child.stdin?.end()`) after starting it. `execFile` otherwise leaves stdin open and unwritten; if glab ever prompts interactively (e.g. `glab stack sync` asking fork vs. upstream, with no flag to suppress it), an open stdin nobody writes to or closes makes glab block forever on EOF instead of failing — the AXI contract that no command may ever hang. Closing it turns any such prompt into glab's own non-interactive error, with its exit code and message flowing through `toExecResult`/`mapGlabError` as usual. This is deliberately global, not stack-specific: nothing in this codebase relies on an open stdin on the `run()` path (only `glabExecWithStdin`'s `runWithStdin` writes to it, via its own separate code path).

`RepoContext` is `{ fullPath, source, host? }`. GitLab namespaces nest, so there is no owner/name pair and no `nwo`: `group/subgroup/project` is one `fullPath`. `buildArgs` appends **`-R <fullPath>`** (not `--repo`) when `source !== "git"`, letting glab auto-detect the git remote otherwise.

`glabApiJson` never appends `-R` (glab 1.97 does accept `-R` on `glab api` and resolves it against `:id`, but `glab api` has no other way to pass a project, so relying on it would leave every other flag ordering untested). The project travels inside the path as the URL-encoded `:id` instead, substituted by `glabApiJson` itself from the context (`encodedProjectId` in `context.ts`). Its `fields` are split by JS type: strings go to `--raw-field`, booleans and numbers to `--field`, because glab's `--field` does magic type conversion that would turn a title of `"42"` into an integer.

**`glab api --raw-field`/`--field` cannot express nested keys or arrays** — verified live: `files[0][file_path]=x` is sent to GitLab as the literal JSON property name `"files[0][file_path]"`, not a nested array, and GitLab rejects it (`files, content are missing`). Any endpoint that needs a nested body (e.g. snippet `files: [...]`) must go through `glabApiJsonBody(path, body, opts)` instead, which pipes `JSON.stringify(body)` on stdin via `--method <m> --input -`. `glabApiJson`'s `fields` option stays correct for flat bodies.

GitLab speaks `iid` (per-project visible number) for issues and MRs. The global `id` must never surface in the UX.

`mapGlabError` walks `patterns` in order and returns on the first hit, so **order is the contract**: a narrow pattern must sit ahead of any broader one that would swallow it. Traps verified against glab 1.97:

- glab does not print a bare error line. It renders a **box** on stderr — blank line, `ERROR` banner, blank line, then the space-padded message — and prefixes `glab: ` on API failures. `cleanLines()` strips all of that; patterns and reported messages run on the cleaned text, otherwise the reported message is literally `ERROR`. When flat context lines (e.g. a recovery-file notice) precede the box, the box still holds the real reason: `boxedMessage()` extracts the lines between the `ERROR` banner and its closing blank line (rejoining a message glab wrapped across several padded lines) and `firstErrorLine()` prefers it over the first raw line.
- HTTP statuses must be matched only where glab prints one — line start, its `(HTTP 404)` suffix, after the `: ` that follows the request URL, or as a bare `HTTP <code>` word (the `glab: HTTP 400` form glab appends after a JSON error body with no request URL at all). Use the `httpStatus()` helper. A floating `\b404\b` also matches a resource id inside the URL, so any failure on issue/MR iid 400/401/403/404/429 gets misclassified.
- A JSON error body's message can live under either `"message"` or `"error"` — `apiMessage()` checks both.
- `glab mr create` (and other cwd-bound mutations) refuse to run when no local git remote matches the configured host, even when `-R`/`--hostname` targets a different project explicitly — this is glab's own guard, not a glab-axi context bug. It maps to `REPO_RESOLUTION` with a suggestion to run from a checkout of the target project.

## Dependency bumps and the lockfile

The committed `pnpm-lock.yaml` is Prettier-formatted (multi-line `resolution:` and `engines:` blocks), which is not pnpm's native output format.
A plain `pnpm install` rewrites those blocks inline and produces a ~1000-line cosmetic churn even when only one dependency actually changed.
After bumping a dependency, run `pnpm exec prettier --write pnpm-lock.yaml` so the diff collapses to just the real change.
CI uses `pnpm install --frozen-lockfile`, which parses the YAML structurally and accepts the Prettier-formatted lockfile, so the formatting does not break the frozen-install check.

## The SDK-provided `update` command

`glab-axi` runs its CLI through `runAxiCli` from `axi-sdk-js` (`src/cli.ts`) and registers no `update` command of its own.
Since `axi-sdk-js@0.1.8` ships `update` as a `RESERVED_COMMANDS` built-in, `glab-axi` inherits `glab-axi update` for free, and the SDK auto-resolves the npm package name (`glab-axi`) by walking up to the nearest `package.json`.
The SDK also appends a `"built-in":` section to the top-level `--help` output at runtime, so `src/cli.ts`'s `TOP_HELP` constant is a prefix of the rendered help rather than the whole thing.

## Releases

No release automation: releases are plain git tags (`git tag vX.Y.Z`), not published to npm. `.github/workflows/ci.yml` runs lint, test, and build on every push and PR.

## Installable skill (`src/skill.ts` → `skills/glab-axi/SKILL.md`)

The shipped skill stays a minimal stub and defers to the CLI for all actual guidance. glab-axi CLI output (`glab-axi` dashboard, `glab-axi --help`, `glab-axi <command> --help`) is the single source of truth. Never re-duplicate CLI-owned instructions into the skill; prefer a pointer over restated detail.

Unlike gh-axi, glab-axi is **not currently published to npm**, so the skill body points at the `glab-axi` binary resolved from `PATH` (`glab-axi`, `glab-axi --help`, `glab-axi <command> --help`) rather than gh-axi's `npx -y gh-axi …` form — an `npx -y glab-axi` invocation would fail for every installer until (if ever) this fork is published. `pnpm run build:skill -- --check` fails if the committed file drifts from `createSkillMarkdown()`.

## Self-managed host support (`src/host.ts`, `src/cli.ts`)

`glab-axi` targets a self-managed GitLab instance via a global `--hostname <host>` flag or the `GITLAB_HOST` env var; explicit `--hostname` wins.
Like `-R`/`--repo`, `--hostname` must come _after_ the command (the SDK rejects leading flags), and it is stripped from the args before they reach the underlying `glab` (it is never a subcommand flag).
`src/cli.ts`'s `resolveContext` sets `process.env.GITLAB_HOST` only when `--hostname` is present, and `glab.ts#execOptions` also puts it in the child env when the context carries a host, so `glab.ts` is usable without going through the CLI. When no `--hostname` is given, `GITLAB_HOST` is left untouched.
`src/host.ts#resolveHost()` (flag > `GITLAB_HOST` > `gitlab.com`) is the single source of truth for the effective host used when _building or parsing_ URLs — `parseRemoteUrl` in `src/context.ts` matches it in `git remote` URLs, over a single regex that accepts both SSH and HTTPS forms and any depth of nested group.

## Variables (`src/commands/variable.ts`, `src/secretValue.ts`, `src/stdin.ts`, `glab.ts#glabExecWithStdin`)

GitLab has one variable resource, not gh's separate `secret`/`variable` split — `glab` has no `secret` subcommand at all, so `secret.ts` was deleted and its stdin-only discipline was folded into `variableCommand`'s `set`. `--masked`/`--protected`/`--scope` (mapping to GitLab's `environment_scope`) replace gh's env-scope split; `list`/`get` print non-masked values in the clear, matching `glab variable list`/`get`. A `masked: true` variable's value is hidden as `[masked]` by default — even when GitLab returns no `value` at all for it (17.4+ "masked and hidden") — and only shown with `--show-values` (on both `list` and `get`); `schedule view` still shows schedule-variable values unconditionally, since GitLab schedule variables carry no `masked` bit at all — a deliberate asymmetry, not an oversight. `variableSchema(reveal: boolean)` in `variable.ts` builds the field schema per call rather than mutating a shared module-level const, since `list`'s `renderList` and `get`'s `renderDetail` would otherwise share mutable state across calls.

**Invariant, absolute, no exception:** a variable value must never appear in argv (visible via `ps`) or in an error message. `variableCommand`'s `set` always calls `resolveValue(undefined, "variable")` — never with a flag value — so the value can only come from piped stdin, then goes to `glab.ts#glabExecWithStdin` so the wrapped `glab variable set <key>` child (value positional omitted) also never receives it in argv. There is no `--body`/`-b` flag on `set` at all, unlike gh-axi's original `variable` (which allowed an inline value); this is a deliberate tightening for the GitLab port, not a straight port of gh-axi's behavior.
`resolveValue` (`src/secretValue.ts`) throws immediately instead of blocking when stdin is an interactive TTY and no usable value source was provided, since AXI commands must never hang waiting for interactive input. It still carries the `"secret" | "variable"` noun distinction from the gh-axi port (kept unchanged per the port brief, backing `test/secretValue.test.ts`), but only `"variable"` is reachable from this codebase now.

Reads (`list`, `get`) go through `glabApiJson` against `projects/:id/variables[/:key]`; `get`'s optional `--scope` becomes a `filter[environment_scope]` query param. Mutations (`set`, `delete`) go through the `glab variable` subcommand.

## Snippets (`src/commands/snippet.ts`, `src/snippetSelector.ts`)

GitLab has two independent snippet resources — project-scoped (`projects/:id/snippets`, the default) and personal (`/snippets`, no project at all) — selected by a `--personal` flag rather than gh-axi's gist model (personal only). This mirrors gh-axi's user-scoped pattern: personal-snippet handlers must never forward `ctx` to `glabApiJson`/`glabApiText` (`ctx: effectiveCtx` is `undefined` whenever `--personal` is set), or GitLab would resolve `:id` against the wrong (or no) project. `list`/`create` reject `--personal`-less calls outside a repo context rather than silently defaulting, since there is no implicit project to target.
`glab` ships **only** `snippet create` natively (verified via `glab snippet --help`/`glab snippet <sub> --help` on glab 1.97 — no `list`/`view`/`edit`/`delete`), so every subcommand except metadata-only paths goes through `glabApiJson`/`glabApiText` directly rather than a `glab snippet` subcommand; `create`/`edit` use the modern `files[0][file_path]`/`files[0][content]`/`files[0][action]` array form (`content`/`file_name` are deprecated per the GitLab API docs), and `view`'s raw content comes from the `…/raw` endpoint (`glabApiText`, since it answers plain text). gh-axi's `rename`/`clone` subcommands have no equivalent worth porting (no GitLab CLI clone-by-id verb, and file rename is just remove+add through `edit`) and were dropped — the family is `list|view|create|edit|delete`, five subcommands, not gh-axi's seven.
`snippetIdFromSelector` (`src/snippetSelector.ts`) requires a **numeric** id (GitLab, unlike GitHub's alphanumeric gist ids) and accepts both URL shapes (`<host>/<namespace>/<project>/-/snippets/<id>` and `<host>/-/snippets/<id>`), taking the last path segment — both end in the id.

## Stacked diffs (`src/commands/stack.ts`)

Unlike gh-axi's `stack` — a strict adapter over the third-party `github/gh-stack` **extension** — `glab stack` ships **natively** in glab 1.97 (EXPERIMENTAL upstream), so there is no extension-install guidance or "unknown command" detection to port; that whole failure mode from the gh-axi original no longer exists.
The native subcommand set is smaller and differently shaped than gh-stack's (verified via `glab stack --help`/`glab stack <sub> --help`): `create <name>`, `save`, `amend`, `sync`, `list`, `switch <name>`, `next`, `prev`, `first`, `last`, plus two **interactive fuzzy-finder** commands, `move` and `reorder`, that have no non-interactive form and are rejected outright (AXI commands must never go interactive) rather than exposed. gh-stack's `view`/`init`/`add`/`checkout`/`push`/`submit`/`rebase`/`link`/`unstack`/`merge`/`up`/`down`/`top`/`bottom`/`trunk` have no native `glab stack` equivalent and were dropped rather than half-mapped — `next`/`prev`/`first`/`last` cover navigation, and `glab-axi mr merge` covers merging an individual stacked branch.
`save`/`amend` **require** `-m`/`--message` (or `-d`/`--description`, the alias glab itself defines) — glab-axi never lets glab open `$EDITOR`, mirroring the gh-stack adapter's own rule. `sync` can still _ask_ to choose fork vs. upstream when the current repo is a fork (no flag suppresses the prompt itself in glab 1.97) — but it can no longer hang: `src/glab.ts#run()` closes the child's stdin immediately (`child.stdin?.end()`) on every call, not just stack's, so any such prompt hits EOF at once and glab exits non-interactively with its own error/exit code instead of blocking forever. `STACK_HELP`/this note now describe that residual behavior (a `sync` from a fork errors instead of prompting), not a hang to avoid.
Stack commands stay cwd-bound exactly as before: `cli.ts#withLocalRepoContext` still rejects explicit repo flags and `GITLAB_REPO`, and `stackCommand` never receives a `RepoContext`. Successful output is commonly on stderr; both streams are captured and the exact upstream exit code is preserved through `StackError`, reaching the shell only via `cli.ts`'s `formatError` hook — do not swap `glabRaw` for `glabExec` or a generic `mapGlabError`.

## Raw API passthrough (`src/commands/api.ts`)

`glab api` (verified via `glab api graphql --help`, which renders the shared `api` help since `graphql` is a magic endpoint value, not a distinct subcommand) accepts `-X/--method`, `-F/--field` (type-inferred), `-f/--raw-field` (string-only), `-H/--header`, `--input`, `--paginate` — the same surface gh-axi's `api.ts` already exposed, so the port keeps `[<method>] <path>` positional ergonomics (translated to `--method`) rather than adopting glab's flag-only form. Two gh-only flags have no glab equivalent and are rejected rather than silently ignored: `--jq` and `--template` (glab has neither; pipe to `jq` instead). `apiCommand` always passes an explicit `--method` rather than relying on glab's own default-method-flips-to-POST-when-fields-present behavior, so a caller typo in `--field` can never silently turn a `GET` into a `POST`.
Response shaping drops gh-axi's curated `NOISY_KEYS` deny-list and repo/user-object collapsing: GitLab REST responses do not carry GitHub's volume of template/gravatar/permission URLs, so a plain string-length clamp (`--full` to disable) keeps output compact without guessing at GitLab-specific fields to strip without evidence.

## Repeatable flags (`src/args.ts`)

`glab` accepts `--label`, `--assignee`, `--reviewer`, and the `--add-*`/`--remove-*` variants once per value, so glab-axi must collect _every_ occurrence.
Use `getAllFlags`/`takeAllFlags` plus `pushRepeated`; `getFlag`/`takeFlag` keep only the first occurrence and silently discard the rest, which is the bug that recurred as #55, #57, and #75.
Both collectors reject a dangling (`--label` with nothing after it) or blank (`--label=`) value with a `VALIDATION_ERROR` instead of dropping it.
Pick the collector that matches the surrounding file: `mr.ts` and `issue.ts` consume them (`takeAllFlags`).
When a flag becomes repeatable, mark it `(repeatable)` in that command's `*_HELP` string.

`resolveLimit`/`PER_PAGE_MAX` (clamp `--limit` to GitLab's 100-per-page cap) live here too, shared by `ci.ts`, `schedule.ts` and `issue.ts` — do not reintroduce a fourth copy.

## `--version` fast path (`bin/glab-axi.ts`, `src/version.ts`)

`bin/glab-axi.ts` answers a bare `-v`/`-V`/`--version` via `tryFastPath` from `axi-sdk-js/fast-path` (a dependency-free SDK subpath) and only `await import("../src/cli.js")` otherwise, so the version path never loads the command graph (~31ms -> ~20ms, the node floor).
This only works because `src/version.ts` is a LEAF module importing node builtins only - `cli.ts` imports `VERSION` from it, never the reverse. Adding any non-builtin import to `src/version.ts` silently undoes the speedup.
`test/version-fast-path.test.ts` guards it deterministically with a `module.register()` load-hook trace (`test/fixtures/module-trace-*.mjs`) plus a negative control on `--help` (which probes `src/suggestions.js`, the heaviest module `cli.ts` still pulls in). Do not add a wall-clock timing assertion; it was proven flaky under CI contention.

## Issues (`src/commands/issue.ts`)

Reads go through `glabApiJson` against `projects/:id/issues[/:iid]` and are shaped locally before TOON; mutations go through the `glab issue` subcommand that owns the flow (`create`, `close`, `reopen`, `delete`, `update`), same split as `mr.ts`. `comment` is the one deliberate crossing: it posts through the API (`POST …/issues/:iid/notes`) because `glab issue note` returns no parseable output to build a structured response from, even though — unlike `mr note create` — it is not EXPERIMENTAL.

`glab issue update` has no `--yes`, unlike `mr update`; the guard from the old gh-axi port (skip the subcommand call entirely when no field besides the iid changed) is kept because calling it with nothing but the iid still errors.

`create`'s iid extraction reads the created issue's URL, which is **not** stable across instances: GitLab has been migrating issues to work items (16.x+), so a recent/self-managed instance answers `.../-/work_items/<iid>` instead of the classic `.../-/issues/<iid>` — verified live on git.geofoncier.fr with glab 1.97. The regex accepts both forms (`/-\/(?:issues|work_items)\/(\d+)/`); `mr.ts`'s equivalent stays issues-only since MRs were verified to still answer `/-/merge_requests/<iid>`.

`lock`/`unlock` map onto `glab issue update --lock-discussion`/`--unlock-discussion`, gated by the same idempotent-check-then-mutate pattern as `close`/`reopen` (read `discussion_locked` first, no-op with `already: true` when it already matches).

Three gh-axi surfaces were dropped rather than ported, all genuinely GitHub-only with no GitLab REST equivalent — not a straight GraphQL→REST swap:

- `--project <name>` on `create` (GitHub Projects v2 linking).
- `transfer` (GitHub's cross-org issue transfer; GitLab's closest analog, `POST …/issues/:iid/move`, only moves within the same instance and has no `glab` subcommand).
- `subissue add/remove/list` (GitHub's GraphQL parent/child hierarchy; GitLab's nearest REST feature, `projects/:id/issues/:issue_iid/links`, models `relates_to`/`blocks`/`is_blocked_by` between peers, not a hierarchy — different enough semantics that renaming it in place would misrepresent the feature).

`pin`/`unpin` were dropped too: GitLab issues have no pinning concept at all.

`list --sort <created|updated>` maps onto `order_by=created_at|updated_at&sort=desc` (GitLab's `/projects/:id/issues` params), matching gh-axi's original always-descending order. `--sort comments` is rejected with a `VALIDATION_ERROR` explaining it has no GitLab equivalent, rather than silently dropped — GitLab issues carry no comment-count sort key.

## Merge requests (`src/commands/mr.ts`)

Reads go through `glabApiJson` against the REST API and are shaped locally before TOON; mutations go through the `glab mr` subcommand that owns the flow (`create`, `close`, `reopen`, `merge`, `update`, `rebase`, `checkout`, `approve`, `revoke`). Two deliberate crossings of that line:

- **Comments are a mutation done through the API** (`POST …/merge_requests/:iid/notes`), because `glab mr note create` is still marked EXPERIMENTAL and the parent `glab mr note` exposes no `-m`.
- **`mr diff` is a read done through the subcommand** (`glab mr diff --raw`), because the unified diff is already the final form an agent wants: `GET …/merge_requests/:iid/diffs` returns per-file JSON that would have to be reassembled into that same text, and there is no TOON shaping to gain along the way. Keep it on the subcommand.

Every glab mutation is forced non-interactive. `create` always passes `--description` (empty when no body) and `--yes`, since `--yes` only skips the final submission prompt and an absent description opens an editor; `update` and `merge` also pass `--yes`.

`mr merge` always spells out `--auto-merge=true|false`. glab defaults `--auto-merge` to **true** whenever a pipeline is running, so a bare `if (auto) push("--auto-merge")` is a no-op and leaves no way to ask for an immediate merge. `--auto` states the default explicitly, `--now` maps to `--auto-merge=false`, and the two are mutually exclusive.

Deliberate divergences from gh-axi's `pr`, all GitLab vocabulary rather than GitHub's:

- `--base`/`--head` are `--target-branch`/`--source-branch`; `--delete-branch` is `--remove-source-branch`; `pr update-branch` is `mr rebase`; `pr review --request-changes` is `mr review --revoke` (GitLab has no changes-requested verdict, only approve/unapprove).
- `pr revert` has no GitLab counterpart at MR level and is dropped.
- Every rendered number is the `iid`, and the column is named `iid`, never `number`.
- `--body`/`--body-file` are kept as the body channel (shared `takeBody`) even though GitLab calls the field `description`.
- `mr list` reports no `of N total`: the true total lives in the `X-Total` response header, and `glab api --include` would break JSON parsing. gh-axi's `src/totals.ts` (a GitHub search-API filtered-count helper) has no consumer here and was deleted.

`mr edit` maps onto `glab mr update`, which _replaces_ assignees and reviewers unless each name is prefixed: `--add-*` becomes `+name` and `--remove-*` becomes `!name` (`!`, not `-`, so the value is never parsed as a flag).

`mr checks` is pipeline jobs, not GitHub checks: the head pipeline comes from the MR payload's `head_pipeline`, then `GET /projects/:id/pipelines/:pipeline_id/jobs`. A failed job prepends a `glab-axi ci view <pipeline>` suggestion. `mr view --reviews` reads `…/approvals` (whose `approvals_required`/`approvals_left` are Premium-only and must render as `null` on Free) plus the `…/discussions` entries whose first note carries a `position`, which are the diff-anchored review threads.

## CI pipelines (`src/commands/ci.ts`)

`ci` is the port of gh-axi's `run`, against GitLab pipelines. Reads go through `glabApiJson`; the whole module addresses pipelines and jobs by their **`id`**, never the pipeline `iid` — the id is what the GitLab UI and every `web_url` show, and `mr checks` already hands out pipeline ids.

Mapping, all verified against the REST docs and a live instance:

- `list` and `status` both read `GET /projects/:id/pipelines` (`status` as `?ref=<branch>&per_page=1`). **Do not switch `status` to `pipelines/latest`**: that endpoint answers **403** when the ref has no pipeline, which would report the most common benign state of the module's most used command as FORBIDDEN. The list endpoint answers `200 []`, rendered as an explicit `no pipeline for <ref>`. `status` defaults its ref to the checked-out branch (`resolveCurrentBranch` in `context.ts`), even under `-R`.
- `view` -> the pipeline plus `GET /projects/:id/pipelines/:pipeline_id/jobs`, but `view --job` reads `GET /projects/:id/jobs/:job_id` and checks the job's own `pipeline.id`. Filtering the job list would call a job past the 100th missing from a pipeline that does contain it.
- `retry` and `cancel` are **mutations done through the API** (`POST …/pipelines/:id/retry|cancel`, `POST …/jobs/:id/retry`), unlike the `mr` rule of preferring the subcommand: `glab ci retry` only ever retries a _job_ and prompts interactively without one, and `glab ci cancel pipeline` would then be the odd one out.
- `run` does go through `glab ci run` (`--branch`, repeatable `--variables k:v`); the new pipeline id is parsed out of the emitted URL, as in `mr create`.
- `log <job-id>` -> `GET /projects/:id/jobs/:job_id/trace`, which returns **plain text** — hence `glabApiText`. The trace is the runner's raw terminal output, so the ANSI escapes are stripped (gh already hands back a clean log) before the tail-first truncation at 20 000 chars and the best-effort full-log tempfile.
- `watch` polls the pipeline itself (`--interval`, `--timeout`, both bounded): `glab ci status --live` and `glab ci view` are TUIs, and AXI commands must never go interactive. A timeout returns `timed_out: true` rather than an error.
- `src/pipelineStatus.ts` holds the two status sets these commands need, and they are **not** the same: a pipeline on a `manual` gate never advances on its own (`isWatchTerminal`, so `watch` stops) yet is still perfectly cancellable (`isCancelNoop` excludes it). `src/suggestions.ts` reads the same predicates rather than re-listing the literals.

`per_page` is capped at 100 GitLab-side, so `--limit` is clamped rather than promising more than one page returns, and a full page of jobs is reported as truncated instead of reading as the whole pipeline.

## Pipeline schedules (`src/commands/schedule.ts`)

`schedule` is the port of gh-axi's `workflow`. GitHub workflows and GitLab schedules are not the same object — a `.gitlab-ci.yml` is not addressable the way a workflow file is — so the port keeps the shape (`list|view|run|enable|disable`) over `/projects/:id/pipeline_schedules`.
`run` is `glab schedule run <id>` (the API's `POST …/play`), and `enable`/`disable` are `glab schedule update <id> --active=true|false`: the value must be spelled with `=`, and both keep `workflow`'s idempotence check (read the schedule first, report `already_enabled`/`already_disabled` without calling glab).

## Repositories, labels, releases (`src/commands/repo.ts`, `label.ts`, `release.ts`)

All three follow the `mr.ts` split: reads through `glabApiJson` against `projects/:id[/labels|/releases]`, mutations through the owning `glab` subcommand.

`repo`'s `list` has no single `:id` to target — it reads `GET /projects?membership=true` (the caller's own accessible projects), which happens to work with or without a repo context since `glabApiJson` only substitutes `:id` when one appears in the path. `view` drops gh-axi's `issues`/`prs` GraphQL sub-counts and `primaryLanguage` (GitLab's REST project payload carries neither); `open_issues_count` stands in for the issue count. `edit` maps onto `glab repo update`, not `repo edit` — glab has no `edit` verb — and only forwards `--description`/`--default-branch`(`--defaultBranch` on the wire)/`--archive`/`--unarchive`, since glab exposes no visibility or issues/wiki toggle for repo update the way gh does.

`label edit` requires `--label-id` on the wire (glab has no positional label argument); `labelCommand`'s own `edit <name>` positional is passed through as that ID, and `--name` becomes `--new-name` to match glab's actual flag. `label create` is idempotent like the rest of the mutation-idempotence pattern (`release delete`, `mr close`/`reopen`, `issue close`/`reopen`): it pre-checks `GET /projects/:id/labels?search=<name>` (case-insensitive match) and short-circuits to `created: already_exists` instead of calling `glab label create`, rather than letting a duplicate-name error surface from glab.

`release` drops every GitHub draft/prerelease flag (`--draft`, `--prerelease`, `--generate-notes`, `--discussion-category`, `--notes-start-tag`, `--verify-tag`, `--notes-from-tag`, `--fail-on-no-commits`, `--latest`): GitLab releases have no draft or prerelease concept at all, so there is no REST field or `glab` flag to map them onto. `edit` is not a distinct GitLab operation — `glab release create <tag>` create-or-updates by tag — so `release edit` calls the exact same `glab release create` invocation as `release create`; the two only differ in the message glab-axi renders. `download`'s `--pattern` maps to glab's `--asset-name` (its actual flag name for a glob match).

## Home dashboard (`src/commands/home.ts`)

The bare `glab-axi` invocation. Unlike every scoped command family it needs no `RepoContext` at all: `GET /user`, `GET /merge_requests?scope=assigned_to_me&state=opened`, `GET /issues?scope=assigned_to_me&state=opened` and `GET /todos` are all account-scoped, not project-scoped, so it never forwards `ctx` to `glabApiJson` — same reasoning as the "User-scoped commands" pattern above, though the earlier explanation (avoiding an injected `-R`) does not even apply here, since none of these paths contain `:id`. The four calls run in `Promise.all`, each independently `.catch()`-guarded to `undefined`/`[]` so one failing endpoint (e.g. missing scope) still renders the rest of the dashboard instead of failing it outright.

`homeCommand` is also registered in `cli.ts`'s `COMMANDS` under the explicit `"home"` key (not just as the SDK's `options.home` bare-invocation handler) — the SDK (`axi-sdk-js`'s `runAxiCli`) only special-cases an _empty_ argv into `options.home`; a literal `glab-axi home` is looked up in `options.commands` like any other named command and answered `Unknown command` if absent. Routing it explicitly renders the same dashboard, just without the SDK's home-view header merge (`isHomeView` is only true for the bare form).

## Token-savings recorder (`src/gain.ts`, `src/commands/gain.ts`)

Per-invocation measurement of what this CLI saves an agent:
`saving = tokens(raw GitLab API bodies) − tokens(rendered stdout)`. One JSONL line per
invocation in the platform data dir (`~/Library/Application Support/axi/glab-axi.jsonl`,
XDG elsewhere), read back by `glab-axi gain`.

The recorder is a **per-repo copy** of the one in `sonarqube-axi` (Florian's decision,
design `~/work/brain/geofoncier/docs-conception/2026-09-01-axi-gain-design.md`): no shared
package, no new cross-module dependency. A fix found here must be carried by hand to the
other AXI modules.

Three things that do not survive a careless edit:

- **The counting point is `recordApiBody` in `src/glab.ts`**, called from the single
  `toExecResult` callback both `run` and `runWithStdin` resolve through, and gated on
  `args[0] === "api"`. That covers `runApi` (`glabApiJson`/`glabApiText`), `glabApiJsonBody`
  and `api.ts`'s passthrough, exactly once per response, `--paginate` included (glab
  concatenates pages into one stdout). Subcommand invocations (`glab mr create`, …) are
  deliberately _not_ counted: their stdout is glab's own rendering, not an HTTP body.
  A failed API call answers on stderr and stays counted — this module has **no** retry or
  auth-fallback path, so there is no `dropRetriedRawBody` equivalent to port.
- **`gpt-tokenizer` is a dynamic import inside `flushGain`, after stdout is written.** It
  loads large BPE tables; importing it at module scope would delay every rendered output
  and defeat the `--version` fast path. `test/version-fast-path.test.ts` asserts the module
  never appears in a `--help` trace.
- **Nothing here may fail a command.** `flushGain` is one silent `try/catch`; the
  unwritable-log test in `test/gain.test.ts` stubs `process.platform` (restored in a
  `finally`) so both the macOS and the XDG branch are exercised on either runner, and it
  was verified to fail when the `try/catch` is removed.

Privacy is a hard constraint: the line carries integers plus a sub-command name resolved by
`gainCommandName` against `COMMAND_NAMES`. An argv whose first token is not in that list
writes no line at all. `AXI_GAIN=0` disables recording, the tokenizer import included.

`sinceIso` reduces over the entries instead of `Math.min(...entries.map(…))`: the log is
append-only and unbounded, and spreading a few hundred thousand arguments throws a
`RangeError`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
