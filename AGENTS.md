# Contribution Rules

- Use Conventional Commits: `type(scope): imperative description`.
- Before committing, check `README.md`; if it does not document the change, update it first.
- Run the relevant checks and `git diff --check` before committing.
- Stage only files related to the current change; never use `git add -A` blindly.
- Keep commits signed and push only after the README and checks pass.
- Amend published commits only with `git push --force-with-lease`, never plain `--force`.
- Keep this public setup repo generic: no secrets, internal URLs, employer details, or machine-specific paths.
- Edit the live file under `~/.pi/agent/` first and publish via `./sync.sh`; edit a repo file directly only where sync can't carry it (`README.md` docs, `bin/`, `scripts/`).
