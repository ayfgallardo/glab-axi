# glab-axi

GitLab CLI for agents — designed with [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface).

Port of [gh-axi](https://github.com/kunchenguid/gh-axi) (Kun Chen, MIT license) to GitLab: wraps the official [`glab`](https://gitlab.com/gitlab-org/cli) CLI with token-efficient TOON output, contextual next-step suggestions, and structured AXI error handling. Built for autonomous agents that interact with GitLab via shell execution. Works with gitlab.com and self-managed instances.

## Origin

This project is a from-scratch reimplementation of gh-axi's command surface and conventions against `glab` instead of `gh`. Full credit for the original design (AXI conventions, TOON output, suggestion engine, command UX) goes to [kunchenguid/gh-axi](https://github.com/kunchenguid/gh-axi), MIT licensed. See `LICENSE` for the full terms.

## Install

Not published on npm — install straight from this repository:

```sh
npm install -g git+https://github.com/ayfgallardo/glab-axi
```

### Prerequisites

- [`glab`](https://gitlab.com/gitlab-org/cli) installed and authenticated: `glab auth login`.
- Node.js 20 or newer.

## Commands

Run `glab-axi --help` for the full command list and `glab-axi <command> --help` for a command's flags — the CLI's own `--help` output is the source of truth, not this README.

- `glab-axi` (no command) — dashboard: open issues/MRs/pipelines at a glance.
- `issue` — list, view, create, and manage GitLab issues.
- `mr` — list, view, create, and manage merge requests.
- `ci` — inspect and manage CI/CD pipelines and jobs.
- `schedule` — manage pipeline schedules.
- `snippet` — manage GitLab snippets.
- `label` — manage project labels.
- `release` — manage releases and their assets.
- `repo` — repository-level operations (view, clone, archive, etc.).
- `variable` — manage CI/CD variables (project and instance scope).
- `stack` — thin adapter over stacked-diff style workflows.
- `api` — call the GitLab REST API directly, with the same AXI conventions.
- `setup` — install shell hooks and other one-time setup steps.

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

_Pending — token comparison of raw `glab` vs `glab-axi` output on the ported read commands._
