# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Port status: gh-axi → glab-axi

This repository is a port of gh-axi 0.1.35 (a `gh` wrapper) to `glab`. The core layer is ported; the command families are not yet.

Ported and authoritative: `src/glab.ts`, `src/context.ts`, `src/errors.ts`, `src/host.ts`, `src/cli.ts`, `src/version.ts`, `src/args.ts`, `bin/glab-axi.ts`, `src/commands/issue.ts`, `src/commands/mr.ts`, `src/commands/ci.ts`, `src/commands/schedule.ts`, `src/commands/repo.ts`, `src/commands/label.ts`, `src/commands/release.ts`, `src/commands/variable.ts`, `src/commands/home.ts`, and the `issue`, `mr`, `ci`, `schedule`, `repo`, `label`, `release`, `variable` and `home` entries of `src/suggestions.ts`. `src/commands/secret.ts` no longer exists — GitLab has no `secret` resource, and its stdin-only value discipline was folded into `variable.ts`'s `set` (see "Variables" below).
Not yet ported: the rest of `src/commands/` (`snippet`, `stack`, `api`, `setup`, plus the still-gh-shaped `gist.ts`, `project.ts`, `search.ts`) plus `src/totals.ts`, `src/gistSelector.ts` and their domains of `src/suggestions.ts`. Every unported command family routes to an inline stub in `cli.ts` that throws `not ported yet`.

The unported gh modules are held out of the graph so build and test stay green: `tsconfig.json` excludes them file by file (alongside `src/totals.ts`), and `vitest.config.ts` carries a commented `NOT_PORTED_YET` list naming the lot that reclaims each suite. **Each port lot removes its own entry from both lists** — `describe.skip` is not an option, because a suite whose import fails errors before the skip is evaluated.

Sections below tagged **[gh-era]** describe the unported modules and still say `gh`, `ghJson`, `nwo`, `GH_HOST`. Treat them as a description of the source material to port, never as a description of current behavior.

## glab invocation core (`src/glab.ts`, `src/context.ts`, `src/errors.ts`)

Command modules talk to glab through `src/glab.ts` only: `glabJson`, `glabExec`, `glabRaw`, `glabExecWithStdin`, `glabApiJson`, `glabApiText` (same call as `glabApiJson` for the endpoints that answer plain text, such as a job trace). All go through `execFile("glab", …)` — never a shell.

`RepoContext` is `{ fullPath, source, host? }`. GitLab namespaces nest, so there is no owner/name pair and no `nwo`: `group/subgroup/project` is one `fullPath`. `buildArgs` appends **`-R <fullPath>`** (not `--repo`) when `source !== "git"`, letting glab auto-detect the git remote otherwise.

`glab api` accepts no `-R` at all. The project travels inside the path as the URL-encoded `:id`, and glab only resolves that placeholder from the current checkout — so `glabApiJson` substitutes it itself from the context (`encodedProjectId` in `context.ts`) and never appends `-R`. Its `fields` are split by JS type: strings go to `--raw-field`, booleans and numbers to `--field`, because glab's `--field` does magic type conversion that would turn a title of `"42"` into an integer.

GitLab speaks `iid` (per-project visible number) for issues and MRs. The global `id` must never surface in the UX.

`mapGlabError` walks `patterns` in order and returns on the first hit, so **order is the contract**: a narrow pattern must sit ahead of any broader one that would swallow it. Two glab-specific traps, both verified against glab 1.97:

- glab does not print a bare error line. It renders a **box** on stderr — blank line, `ERROR` banner, blank line, then the space-padded message — and prefixes `glab: ` on API failures. `cleanLines()` strips all of that; patterns and reported messages run on the cleaned text, otherwise the reported message is literally `ERROR`.
- HTTP statuses must be matched only where glab prints one — line start, its `(HTTP 404)` suffix, or after the `: ` that follows the request URL. Use the `httpStatus()` helper. A floating `\b404\b` also matches a resource id inside the URL, so any failure on issue/MR iid 400/401/403/404/429 gets misclassified.

## Dependency bumps and the lockfile

The committed `pnpm-lock.yaml` is Prettier-formatted (multi-line `resolution:` and `engines:` blocks), which is not pnpm's native output format.
A plain `pnpm install` rewrites those blocks inline and produces a ~1000-line cosmetic churn even when only one dependency actually changed.
After bumping a dependency, run `pnpm exec prettier --write pnpm-lock.yaml` so the diff collapses to just the real change.
CI uses `pnpm install --frozen-lockfile`, which parses the YAML structurally and accepts the Prettier-formatted lockfile, so the formatting does not break the frozen-install check.

## The SDK-provided `update` command

`glab-axi` runs its CLI through `runAxiCli` from `axi-sdk-js` (`src/cli.ts`) and registers no `update` command of its own.
Since `axi-sdk-js@0.1.8` ships `update` as a `RESERVED_COMMANDS` built-in, `glab-axi` inherits `glab-axi update` for free, and the SDK auto-resolves the npm package name (`glab-axi`) by walking up to the nearest `package.json`.
The SDK also appends a `"built-in":` section to the top-level `--help` output at runtime, so `src/cli.ts`'s `TOP_HELP` constant is a prefix of the rendered help rather than the whole thing.

## Release process

Releases are cut by release-please from conventional commit messages on `main`; merging the bot's release PR triggers `npm publish` via `.github/workflows/release-please.yml`.
Do not hand-edit `CHANGELOG.md` or `.release-please-manifest.json` (a guard workflow blocks PRs that touch them), and regenerate `skills/gh-axi/SKILL.md` with `pnpm run build:skill` instead of editing it directly.

Every `pull_request` workflow (`ci.yml`, `guard-generated-files.yml`, `no-mistakes-required.yml`) uses `paths-ignore` for the release-please output set (`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`) so release PRs create zero runs. Job-level bot `if`s stay as defense in depth. `test/release-ci-exclusions.test.ts` derives that set from `release-please-config.json` and fails if a workflow drifts; update the ignore lists when adding `extra-files` or changing `release-type`.

## Installable skill (`src/skill.ts` → `skills/gh-axi/SKILL.md`)

**[gh-era]** Source material for a later port lot, not current behavior.

The shipped skill stays a minimal stub and defers to the CLI for all actual guidance. gh-axi CLI output (`gh-axi` dashboard, `gh-axi --help`, `gh-axi <command> --help`) is the single source of truth. Never re-duplicate CLI-owned instructions into the skill; prefer a pointer over restated detail.

## Self-managed host support (`src/host.ts`, `src/cli.ts`)

`glab-axi` targets a self-managed GitLab instance via a global `--hostname <host>` flag or the `GITLAB_HOST` env var; explicit `--hostname` wins.
Like `-R`/`--repo`, `--hostname` must come _after_ the command (the SDK rejects leading flags), and it is stripped from the args before they reach the underlying `glab` (it is never a subcommand flag).
`src/cli.ts`'s `resolveContext` sets `process.env.GITLAB_HOST` only when `--hostname` is present, and `glab.ts#execOptions` also puts it in the child env when the context carries a host, so `glab.ts` is usable without going through the CLI. When no `--hostname` is given, `GITLAB_HOST` is left untouched.
`src/host.ts#resolveHost()` (flag > `GITLAB_HOST` > `gitlab.com`) is the single source of truth for the effective host used when _building or parsing_ URLs — `parseRemoteUrl` in `src/context.ts` matches it in `git remote` URLs, over a single regex that accepts both SSH and HTTPS forms and any depth of nested group.

## Variables (`src/commands/variable.ts`, `src/secretValue.ts`, `src/stdin.ts`, `glab.ts#glabExecWithStdin`)

GitLab has one variable resource, not gh's separate `secret`/`variable` split — `glab` has no `secret` subcommand at all, so `secret.ts` was deleted and its stdin-only discipline was folded into `variableCommand`'s `set`. `--masked`/`--protected`/`--scope` (mapping to GitLab's `environment_scope`) replace gh's env-scope split; `list`/`get` print values, matching `glab variable list`/`get` — GitLab variables are not secrets.

**Invariant, absolute, no exception:** a variable value must never appear in argv (visible via `ps`) or in an error message. `variableCommand`'s `set` always calls `resolveValue(undefined, "variable")` — never with a flag value — so the value can only come from piped stdin, then goes to `glab.ts#glabExecWithStdin` so the wrapped `glab variable set <key>` child (value positional omitted) also never receives it in argv. There is no `--body`/`-b` flag on `set` at all, unlike gh-axi's original `variable` (which allowed an inline value); this is a deliberate tightening for the GitLab port, not a straight port of gh-axi's behavior.
`resolveValue` (`src/secretValue.ts`) throws immediately instead of blocking when stdin is an interactive TTY and no usable value source was provided, since AXI commands must never hang waiting for interactive input. It still carries the `"secret" | "variable"` noun distinction from the gh-axi port (kept unchanged per the port brief, backing `test/secretValue.test.ts`), but only `"variable"` is reachable from this codebase now.

Reads (`list`, `get`) go through `glabApiJson` against `projects/:id/variables[/:key]`; `get`'s optional `--scope` becomes a `filter[environment_scope]` query param. Mutations (`set`, `delete`) go through the `glab variable` subcommand.

## User-scoped commands (`src/commands/gist.ts`, `src/commands/project.ts`)

**[gh-era]** Source material for a later port lot, not current behavior.

Some GitHub API endpoints are user-scoped rather than repo-scoped: `gh api /gists` and `gh project` have no `--repo` flag and reject it if supplied.
`gh.ts#buildArgs` auto-appends `--repo <nwo>` for any `RepoContext` whose `source !== "git"`, so passing ctx to `ghJson` from these handlers would inject a flag the CLI rejects.
The fix is structural: these command functions omit the `ctx` parameter entirely (TypeScript accepts `(args: string[])` as `CommandFn` because fewer params are always assignable).
`cli.ts`'s `withRepoContext` wrapper still resolves a context for other commands — it just never reaches `ghJson` in the user-scoped handlers.
`gist.ts` follows this pattern; `project.ts` does too (though it additionally uses ctx?.owner for owner defaulting, it never forwards ctx to `ghJson`).

## GitHub Projects (`gh project`) support (`src/commands/project.ts`)

**[gh-era]** Source material for a later port lot, not current behavior.

Unlike every other command family, `gh project` is owner-scoped (`--owner <login>`), not repo-scoped — it has no `--repo` flag at all.
`project.ts`'s subfunctions therefore never pass `RepoContext` as the second arg to `ghJson` (matching `search.ts`'s existing pattern) — see "User-scoped commands" above for why.
Instead, `resolveOwner()` defaults `--owner` to the current repo's owner (`ctx?.owner`) when the flag is omitted and a repo context is available, falling back to explicit `@me` otherwise because `gh project` requires an owner in non-interactive shells.
`gh project` subcommands use `--format json` (whole-object dump), not the `--json field,field` selection style used by `issue`/`pr`/`release`; list-shaped responses come back wrapped (e.g. `{ projects: [...], totalCount }`), not as a bare array.
Since Projects v2 items carry per-project custom fields (Status, Priority, ...) with no fixed schema, `item-list`/`field-list` render through bespoke functions (`renderProjectItems`/`renderProjectFields`) that flatten any unknown scalar top-level key into its own column, rather than a fixed `FieldDef` schema.
Requires the `project` (or `read:project`) OAuth scope on the `gh` token; `src/errors.ts` matches gh's literal `"authentication token is missing required scopes [...]"` stderr (verified against a live token missing the scope) and maps it to `FORBIDDEN` with a `gh auth refresh -s <scope>` suggestion — this pattern is generic, not project-specific, so it also covers other gh features gated by OAuth scopes.

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

## Stacked PR support (`src/commands/stack.ts`)

**[gh-era]** Source material for a later port lot, not current behavior.

`gh-axi stack` is deliberately a strict adapter over the official `github/gh-stack` extension, not a second stack engine. Keep local metadata, Git mutation, rebase recovery, and Stacks API behavior upstream.
Stack commands are cwd-bound. `cli.ts#withLocalRepoContext` rejects explicit repo flags and `GH_REPO`, strips the supported host flag, and never passes a `RepoContext` to `ghRaw`, because the extension does not accept `--repo`.
Successful extension status is commonly written to stderr, and exits 2-10 represent actionable stack state. Preserve both streams and the exact `StackError.exitCode`, which reaches the shell only through `cli.ts`'s `formatError` hook; do not replace `ghRaw` with `ghExec` or generic `mapGhError`.
Never expose an interactive path. Force `view --json`, `submit --auto`, and `merge --yes`; require arguments for commands that otherwise prompt. Keep `modify`, `switch`, `alias`, and `feedback` out unless upstream gains a useful headless interface.

## Issues (`src/commands/issue.ts`)

Reads go through `glabApiJson` against `projects/:id/issues[/:iid]` and are shaped locally before TOON; mutations go through the `glab issue` subcommand that owns the flow (`create`, `close`, `reopen`, `delete`, `update`), same split as `mr.ts`. `comment` is the one deliberate crossing: it posts through the API (`POST …/issues/:iid/notes`) because `glab issue note` returns no parseable output to build a structured response from, even though — unlike `mr note create` — it is not EXPERIMENTAL.

`glab issue update` has no `--yes`, unlike `mr update`; the guard from the old gh-axi port (skip the subcommand call entirely when no field besides the iid changed) is kept because calling it with nothing but the iid still errors.

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
- `mr list` reports no `of N total`: the true total lives in the `X-Total` response header, and `glab api --include` would break JSON parsing. `src/totals.ts` stays unported.

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

## Raising PRs to upstream

Human-authored PRs targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) (`no-mistakes init --fork-url git@github.com:<you>/gh-axi.git`, then `git push no-mistakes`): the `Require no-mistakes` workflow fails any PR whose body lacks the pipeline's deterministic signature, and maintainer triage treats hand-raised PRs as blocked. Do not push a PR branch straight to `origin`. See CONTRIBUTING.md.

`.github/workflows/no-mistakes-required.yml` is a thin caller of the shared `kunchenguid/no-mistakes/.github/actions/require-no-mistakes` composite action, pinned to an immutable commit SHA and never `@main` (main is editable by the very PR the gate judges). Enforcement logic - the `Updates from [git push no-mistakes]` signature check, the `<!-- no-mistakes-pipeline-attestation:v1 {...} -->` parse, and the head binding - and its tests live upstream in the no-mistakes repository; change enforcement there rather than copying it locally, and bump this repository's pin in a deliberate separate pull request. This repository still owns its `on:`, `paths-ignore`, `concurrency`, `permissions`, job name, and author-exemption `if:`.
The shared action's head binding means a PR whose body no-mistakes did not rewrite for the current head goes red. That is the attestation contract, not a flake: push through `git push no-mistakes` so the body is refreshed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
