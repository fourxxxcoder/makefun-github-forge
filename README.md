# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/fourxxxcoder/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/fourxxxcoder/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge that runs as a single Node.js process using nothing beyond the standard library. It serves git smart HTTP (protocol v0 and v2: ref advertisement, ls-refs, fetch with shallow-clone support, and receive-pack with report-status and fast-forward enforcement), the GitHub REST v3 surface (repositories, contents, branches, commits, labels, issues, comments, and pull requests with squash merges), the GraphQL v4 API (queries, mutations, cursor-paginated connections, and introspection), and an MCP endpoint with repository, issue, and pull-request tools — all over one shared in-memory store, so an object created through any surface is the same object on every other. There is no database, no git binary, and nothing to install.

## Run it

```sh
MAKEFUN_ENV_URL=<the platform env URL> MAKEFUN_SHOP_TOKEN=<the shop token> node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, answers `GET /healthz`, and serves until the env reports the run is done. Every API and git route expects `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=7z89ba3s&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
