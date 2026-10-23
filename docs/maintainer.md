# Maintainer notes

## Source of truth

The live setup is `~/.pi/agent/`. This repo is the published mirror. The owner edits the live files,
then pulls the shareable subset back into the repo.

`sync.sh` is **untracked on purpose** (see `.gitignore`). It is a personal publishing tool, not part of
what a user installs. Its behaviour:

1. Mirrors `~/.pi/agent/extensions/` into `extensions/`, excluding `node_modules`, `cmux-session.ts`,
   `orca-*`, and `README.md` (READMEs are maintained in the repo).
2. Mirrors `utils/`.
3. Refreshes themes, rules, agents, and skills from an **allowlist**: the file list in the repo is the
   allowlist, so private or employer-specific resources never get published even though they live in
   the same live directories.
4. Leaves `stats.ts` and `utils/omp-stats/` local. They are excluded from the public repo.

After syncing: `git status --short`, `git diff`, update the affected README, then commit and push.

## Adding a public component

1. Create it live in `~/.pi/agent/`.
2. Add it to the appropriate allowlist in `sync.sh` (rules, themes, agents, skills) or let the
   extension mirror pick it up.
3. Run `./sync.sh`.
4. Add an entry to `harness.json`: `id`, `type`, `tier`, `path`, `npm`, `env`, `requires`, `summary`.
5. Add a README next to the code.
6. Run `npm run check:manifest` and `npm test`.
7. Update `README.md` if the counts or the tier table changed.

The drift test fails when a file is neither classified nor excluded, so a forgotten step surfaces in
CI rather than in a user's install.

## Releases

1. Bump `version` in `package.json` and `harness.json` together.
2. Add a `CHANGELOG.md` section.
3. Commit, then create an annotated tag: `vX.Y.Z`.
4. Push the branch and the tag.
5. The installer reports the manifest version, so a user can see what they are running.

`0.x` is deliberate: this is a personal setup that moves. Breaking changes are allowed between minor
versions; the CHANGELOG says what moved.

## Repository settings

- `main` is protected: CI must pass, one review required, stale reviews dismissed, force pushes and
  deletions blocked.
- Squash-merge is the default; branches are deleted after merge.
- DCO sign-off is required; there is no CLA.
- CODEOWNERS routes everything to the maintainer.

## What must never be published

- `~/.pi/agent/mcp.json`, `auth.json`, `settings.json`, prompts, session state.
- Rules, agents, or skills that name an employer, internal service, or private API.
- Machine-specific paths, tokens, and account IDs.
- `sync.sh`, `MAINTAINER.md`, `.pi/tasks/`, `utils/omp-stats/`, `extensions/stats.ts`.
