# glab-axi

GitLab CLI for agents — designed with [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface).

Port of [gh-axi](https://github.com/kunchenguid/gh-axi) (Kun Chen, MIT) to GitLab: wraps the official `glab` CLI with token-efficient TOON output, contextual next-step suggestions, and structured error handling. Built for autonomous agents that interact with GitLab via shell execution. Works with gitlab.com and self-hosted instances.

## Install

Not published on npm — install straight from this repository:

```sh
npm install -g git+https://github.com/ayfgallardo/glab-axi
```

Requires [`glab`](https://gitlab.com/gitlab-org/cli) installed and authenticated (`glab auth login`) and Node 20+.

## Benchmark

_Pending — token comparison of raw `glab` vs `glab-axi` output on the ported read commands._
