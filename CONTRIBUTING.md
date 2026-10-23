# Contributing

Thanks for looking. This is a personal setup that got useful enough to share — contributions are
welcome when they make the harness **more useful to more people** without making it fragile for the
people already using it.

## Ways to contribute

- **Bug reports** — open an issue with your pi version, OS, and the output of `./install.sh --dry-run`.
- **A fix** — small, focused pull requests are easiest to review.
- **A new extension, rule, agent, or skill** — open an issue first so we can agree it belongs in a
  shipped tier rather than in your local setup.
- **Docs** — the `docs/` tree is the highest-leverage place to help.

## Development setup

```bash
git clone https://github.com/venkateshv1266/pi-harness.git
cd pi-harness
npm install
npm test
```

The test suite has two runtimes: Node for most extensions, and Bun for `extensions/observatory`
(it uses `bun:sqlite`). Install Bun if you want to run the second half. `npm run test:node` and
`npm run test:bun` run them separately.

To try the installer against a throwaway home directory:

```bash
HOME=/tmp/pi-harness-test ./install.sh --yes
```

Never test against your real `~/.pi/agent` if you can avoid it — the installer writes there.

## Adding a component

1. Put the code under `extensions/`, `rules/`, `agents/`, `skills/`, or `themes/`.
2. Add an entry to `harness.json` (or confirm the directory group already covers it).
   The `tier` decides who gets it: `core`, `subagents`, `jev`, `integrations`, or `local`.
3. Document it next to the code: a `README.md` for directory extensions, a sibling `.md` for
   single-file extensions.
4. Add a test when the behaviour is testable. `npm run check:manifest` must stay green — it fails
   when a file is neither classified nor explicitly excluded.

## Conventions

- **Commits**: `type(scope): imperative subject`, for example `fix(install): back up settings before writing`.
  Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
- **DCO sign-off**: every commit needs a `Signed-off-by:` trailer. Add `--signoff` to your commit
  command, or paste the trailer into the message yourself. There is no CLA to sign.
- **Scope**: keep pull requests to one concern. A new extension plus an unrelated refactor is two PRs.
- **Style**: no narrating comments; comment only non-obvious invariants. Sparse, load-bearing comments.

## Pull request expectations

- CI must be green: manifest check, Node tests, Bun tests.
- One maintainer review. Expect questions about failure modes and what happens when a dependency
  (Jev, Grafana, Bun) is absent.
- The maintainer may decline a component that only works in one person's environment. The bar is
  "a stranger can run it, or it is clearly opt-in".
- Squash-merge is the default; your branch is deleted after merge.

## What is out of scope

- Employer-specific, internal, or personal infrastructure. Rules and extensions that reference
  private services belong in your local `~/.pi/agent/`, not here.
- Secrets, tokens, account IDs, and machine-specific paths. `npm run check:manifest` does not scan
  for these — reviewers do.
- Changes that require a paid third-party service to pass CI.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.
