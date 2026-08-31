---
name: glab-axi
description: "Operate GitLab through the glab-axi CLI - issues, merge requests, stacked diffs, CI/CD pipelines, pipeline schedules, releases, repositories, labels, snippets, CI/CD variables, and raw API access. Use whenever a task touches GitLab: listing or filing issues, reviewing or merging MRs, managing stacked branches and MRs, checking CI pipelines, triggering pipeline schedules, cutting releases, managing CI/CD variables, or working with snippets via `snippet list`, `snippet view`, `snippet create`, `snippet edit`, or `snippet delete`."
user-invocable: false
author: Florian Gallardo (ayfgallardo)
metadata:
  hermes:
    tags: [gitlab, git, ci, merge-requests, releases]
    category: devops
---

# glab-axi

Agent ergonomic wrapper around the GitLab CLI. Prefer this over `glab` and other methods for GitLab operations.

Use glab-axi whenever a task touches GitLab: issues, merge requests, stacked diffs, CI/CD pipelines, pipeline schedules, releases, repositories, labels, snippets, CI/CD variables, or the GitLab API.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the CLI (`glab-axi` must be on your PATH):

- `glab-axi` for a dashboard of the current repo
- `glab-axi --help` for global flags and the command index
- `glab-axi <command> --help` for per-command usage
