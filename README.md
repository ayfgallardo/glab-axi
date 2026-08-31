# glab-axi

GitLab CLI for agents — designed with [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface).

Port of [gh-axi](https://github.com/kunchenguid/gh-axi) (Kun Chen, MIT license) to GitLab: wraps the official [`glab`](https://gitlab.com/gitlab-org/cli) CLI with token-efficient TOON output, contextual next-step suggestions, and structured AXI error handling. Built for autonomous agents that interact with GitLab via shell execution. Works with gitlab.com and self-managed instances.

## Why

Raw `glab` output is built for a human terminal: some commands print thousands of tokens of near-duplicate JSON/text an agent has to re-parse, others print almost nothing an agent can act on. `glab-axi` follows the [AXI](https://github.com/kunchenguid/axi) conventions: responses are encoded as [TOON](https://github.com/toon-format/toon) instead of raw text, every response carries contextual suggestions for the next command, and failures come back as structured errors instead of a shell exit code and a stderr blob.

## Origin

This project is a from-scratch reimplementation of gh-axi's command surface and conventions against `glab` instead of `gh`. Full credit for the original design (AXI conventions, TOON output, suggestion engine, command UX) goes to [kunchenguid/gh-axi](https://github.com/kunchenguid/gh-axi), MIT licensed. See `LICENSE` for the full terms.

## Install

Not published on npm — install straight from this repository:

```sh
npm install -g git+https://github.com/ayfgallardo/glab-axi
```

If your npm registry policy blocks git installs, clone and install from the local checkout instead:

```sh
git clone https://github.com/ayfgallardo/glab-axi && npm install -g ./glab-axi
```

### Prerequisites

- [`glab`](https://gitlab.com/gitlab-org/cli) installed and authenticated: `glab auth login`.
- Node.js 20 or newer.

## Commands

Run `glab-axi --help` for the full command list and `glab-axi <command> --help` for a command's flags — the CLI's own `--help` output is the source of truth, not this README.

| Command    | Purpose                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `glab-axi` | (no command) — dashboard: open issues/MRs/pipelines at a glance.                   |
| `issue`    | List, view, create, and manage GitLab issues.                                      |
| `mr`       | List, view, create, and manage merge requests.                                     |
| `ci`       | Inspect and manage CI/CD pipelines and jobs.                                       |
| `schedule` | Manage pipeline schedules.                                                         |
| `snippet`  | Manage GitLab snippets.                                                            |
| `label`    | Manage project labels.                                                             |
| `release`  | Manage releases and their assets.                                                  |
| `repo`     | Repository-level operations (view, clone, archive, etc.).                          |
| `variable` | Manage CI/CD variables (project scope; `--scope` sets GitLab's environment_scope). |
| `stack`    | Thin adapter over stacked-diff style workflows.                                    |
| `api`      | Call the GitLab REST API directly, with the same AXI conventions.                  |
| `setup`    | Install shell hooks and other one-time setup steps.                                |

## Custom hosts

By default `glab-axi` targets `gitlab.com`. Point it at a self-managed instance with either:

- the global `--hostname <host>` flag, placed **after** the command (e.g. `glab-axi mr list --hostname gitlab.example.com`), or
- the `GITLAB_HOST` environment variable.

An explicit `--hostname` always wins over `GITLAB_HOST`.

## Known limitations

- No `project` or `search` command families — not ported from gh-axi.
- `stack sync` run from a fork context prompts interactively upstream; since `glab-axi` never attaches a TTY, the closed stdin turns that prompt into an error instead of hanging.
- Not published to npm; install from the git repository as shown above.

## Benchmark

Tokens (`o200k_base`) of raw `glab` output vs `glab-axi` output, on the ported read commands, measured 2026-08-31 against a live GitLab project. Methodology, the exact glab sequences, and known anomalies are in `bench/README.md`; rerun with `pnpm exec tsx bench/run.ts`.

| Command       | Tokens glab | Tokens glab-axi | Delta %  | Note                                                                                      |
| ------------- | ----------- | --------------- | -------- | ----------------------------------------------------------------------------------------- |
| mr list       | 273         | 268             | -1.8%    |                                                                                           |
| mr view       | 369         | 269             | -27.1%   |                                                                                           |
| ci status     | 119         | 211             | +77.3%   |                                                                                           |
| ci view       | 19192       | 708             | -96.3%   |                                                                                           |
| issue list    | 47          | 101             | +114.9%  |                                                                                           |
| issue view    | 6869        | 202             | -97.1%   |                                                                                           |
| release list  | 1062        | 1911            | +79.9%   |                                                                                           |
| repo view     | 1677        | 90              | -94.6%   |                                                                                           |
| variable list | 139         | 660             | +374.8%  | measured against displayed values (none were `masked`) — `glab` never shows values anyway |
| label list    | 44          | 71              | +61.4%   |                                                                                           |
| snippet list  | 1           | 47              | +4600.0% | empty pair (project with no snippets)                                                     |
| schedule list | 60          | 132             | +120.0%  |                                                                                           |
| home          | 5104        | 162             | -96.8%   |                                                                                           |

Median delta: +61.4%. Commands that replace a very verbose raw API dump with a structured summary (`ci view`, `issue view`, `repo view`, `home`) save the most; `glab`'s already-short listings (`issue list`, `variable list`, `snippet list`, `schedule list`) cost more under `glab-axi`, whose TOON envelope and suggestions carry a fixed overhead that dominates on very small outputs.
