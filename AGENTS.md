# Working in this repository

This is a public pi setup repo. Keep changes generic: no secrets, internal URLs, employer details,
or machine-specific paths.

## Setup

```bash
npm install
npm run check:manifest
npm test
```

The test suite runs on two runtimes: Node for most extensions and Bun for `extensions/observatory`
(it uses `bun:sqlite`). Use `npm run test:node` or `npm run test:bun` to run one half.

## Before you push

- `npm run check:manifest` stays green. It fails when a file under `extensions/`, `rules/`,
  `agents/`, `skills/`, or `themes/` is neither classified in `harness.json` nor explicitly excluded.
- `npm test` stays green. If a suite needs a runtime you do not have, say so in the pull request.
- Update the README next to the code you changed. `README.md` is the index; directory extensions own
  their own README.
- Use conventional commit subjects: `type(scope): imperative description`.
- Add a DCO `Signed-off-by:` trailer (`--signoff`).
- One concern per pull request.

## Adding a component

1. Put the code in the right directory.
2. Add an entry to `harness.json` with a tier: `core`, `subagents`, `jev`, `integrations`, or `local`.
3. Document it next to the code.
4. Add a test where the behaviour is testable.

## Style

- Sparse comments. Do not narrate what the next line does; comment invariants and workarounds.
- Prefer graceful degradation when an optional dependency (Jev, Grafana, Bun) is missing.
- Do not add a dependency that a stranger must pay for to pass CI.

## Maintainer notes

The owner's live-sync workflow (`sync.sh`, publishing from `~/.pi/agent`) is documented in
[docs/maintainer.md](docs/maintainer.md). `sync.sh` is intentionally untracked.
