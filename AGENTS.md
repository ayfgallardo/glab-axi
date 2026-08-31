# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Port status: gh-axi → glab-axi

This repository is a port of gh-axi 0.1.35 (a `gh` wrapper) to `glab`. The core layer is ported; the command families are not yet.

Ported and authoritative: `src/glab.ts`, `src/context.ts`, `src/errors.ts`, `src/host.ts`, `src/cli.ts`, `src/version.ts`, `src/args.ts`, `bin/glab-axi.ts`, `src/commands/mr.ts`, and the `mr` entries of `src/suggestions.ts`.
Not yet ported: the rest of `src/commands/` plus `src/totals.ts`, `src/gistSelector.ts` and the other domains of `src/suggestions.ts`. Every unported command family routes to an inline stub in `cli.ts` that throws `not ported yet`.

The unported gh modules are held out of the graph so build and test stay green: `tsconfig.json` excludes them file by file (alongside `src/totals.ts`), and `vitest.config.ts` carries a commented `NOT_PORTED_YET` list naming the lot that reclaims each suite. **Each port lot removes its own entry from both lists** — `describe.skip` is not an option, because a suite whose import fails errors before the skip is evaluated.

Sections below tagged **[gh-era]** describe the unported modules and still say `gh`, `ghJson`, `nwo`, `GH_HOST`. Treat them as a description of the source material to port, never as a description of current behavior.

## glab invocation core (`src/glab.ts`, `src/context.ts`, `src/errors.ts`)

Command modules talk to glab through `src/glab.ts` only: `glabJson`, `glabExec`, `glabRaw`, `glabExecWithStdin`, `glabApiJson`. All go through `execFile("glab", …)` — never a shell.

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

## Secret/variable value input (`src/secretValue.ts`, `src/stdin.ts`, `gh.ts#ghExecWithStdin`)

**[gh-era]** Source material for a later port lot, not current behavior.

`gh secret list`/`gh variable list` do not support `--limit` or any pagination flag (unlike `issue`/`pr`/`release` list), so `secret.ts`/`variable.ts` list all results in one call with no `--limit` flag of their own.

Secret values must never appear in argv (visible via `ps`) or stdout.
`secretCommand`'s `set` subcommand is stdin-only: it rejects `--body`/`-b`, calls `resolveValue(undefined, "secret")`, and pipes the resolved value to `gh.ts#ghExecWithStdin` so the wrapped `gh secret set` child also never receives the value in argv.
Variable values are not treated as secrets: `variableCommand`'s `set` subcommand may resolve the value from `--body`/`-b` or piped stdin (`resolveValue` in `src/secretValue.ts`, backed by `src/stdin.ts`), and `gh-axi variable list` intentionally prints variable values.
`variable set --body` values are visible in the `gh-axi` process argv, but `ghExecWithStdin` still keeps them out of the child `gh variable set` argv.
`resolveValue` throws immediately instead of blocking when stdin is an interactive TTY and no usable value source was provided, since AXI commands must never hang waiting for interactive input.

`secretCommand`'s `list`/`set`/`delete` forward `--env`/`-e <environment>` to `gh secret ... --env` via `resolveScope` in `src/commands/secret.ts`; the repo/host context flags are already stripped in `cli.ts` before the command sees its args, so `-R`/`--hostname` compose with `--env` for free. `resolveScope` is deliberately strict: a malformed `--env` (missing/empty value), conflicting `--env` flags, gh's other scopes (`--org`/`--user`/`--app`, plus the value-channel `--env-file`), and any unknown flag all throw loudly rather than silently falling back to repo scope. Unknown flags are echoed by name only (the `=value` is stripped) so a secret value can never leak into an error message.

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
Pick the collector that matches the surrounding file: `mr.ts` consumes them (`takeAllFlags`).
When a flag becomes repeatable, mark it `(repeatable)` in that command's `*_HELP` string.

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

## Merge requests (`src/commands/mr.ts`)

Reads go through `glabApiJson` against the REST API and are shaped locally before TOON; mutations go through the `glab mr` subcommand that owns the flow (`create`, `close`, `reopen`, `merge`, `update`, `rebase`, `checkout`, `approve`, `revoke`, `diff --raw`). Comments are the exception: they are posted with `POST …/merge_requests/:iid/notes`, because `glab mr note create` is still marked EXPERIMENTAL.

Every glab mutation is forced non-interactive. `create` always passes `--description` (empty when no body) and `--yes`, since `--yes` only skips the final submission prompt and an absent description opens an editor; `update` and `merge` also pass `--yes`.

Deliberate divergences from gh-axi's `pr`, all GitLab vocabulary rather than GitHub's:

- `--base`/`--head` are `--target-branch`/`--source-branch`; `--delete-branch` is `--remove-source-branch`; `pr update-branch` is `mr rebase`; `pr review --request-changes` is `mr review --revoke` (GitLab has no changes-requested verdict, only approve/unapprove).
- `pr revert` has no GitLab counterpart at MR level and is dropped.
- Every rendered number is the `iid`, and the column is named `iid`, never `number`.
- `--body`/`--body-file` are kept as the body channel (shared `takeBody`) even though GitLab calls the field `description`.
- `mr list` reports no `of N total`: the true total lives in the `X-Total` response header, and `glab api --include` would break JSON parsing. `src/totals.ts` stays unported.

`mr edit` maps onto `glab mr update`, which _replaces_ assignees and reviewers unless each name is prefixed: `--add-*` becomes `+name` and `--remove-*` becomes `!name` (`!`, not `-`, so the value is never parsed as a flag).

`mr checks` is pipeline jobs, not GitHub checks: the head pipeline comes from the MR payload's `head_pipeline`, then `GET /projects/:id/pipelines/:pipeline_id/jobs`. A failed job prepends a `glab-axi ci view <pipeline>` suggestion. `mr view --reviews` reads `…/approvals` (whose `approvals_required`/`approvals_left` are Premium-only and must render as `null` on Free) plus the `…/discussions` entries whose first note carries a `position`, which are the diff-anchored review threads.

## Raising PRs to upstream

Human-authored PRs targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes) (`no-mistakes init --fork-url git@github.com:<you>/gh-axi.git`, then `git push no-mistakes`): the `Require no-mistakes` workflow fails any PR whose body lacks the pipeline's deterministic signature, and maintainer triage treats hand-raised PRs as blocked. Do not push a PR branch straight to `origin`. See CONTRIBUTING.md.

`.github/workflows/no-mistakes-required.yml` is a thin caller of the shared `kunchenguid/no-mistakes/.github/actions/require-no-mistakes` composite action, pinned to an immutable commit SHA and never `@main` (main is editable by the very PR the gate judges). Enforcement logic - the `Updates from [git push no-mistakes]` signature check, the `<!-- no-mistakes-pipeline-attestation:v1 {...} -->` parse, and the head binding - and its tests live upstream in the no-mistakes repository; change enforcement there rather than copying it locally, and bump this repository's pin in a deliberate separate pull request. This repository still owns its `on:`, `paths-ignore`, `concurrency`, `permissions`, job name, and author-exemption `if:`.
The shared action's head binding means a PR whose body no-mistakes did not rewrite for the current head goes red. That is the attestation contract, not a flake: push through `git push no-mistakes` so the body is refreshed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
