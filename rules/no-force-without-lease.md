---
name: no-force-without-lease
condition: ["git push --force(?!.{0,20}with-lease)", "git push -f(?!.{0,20}=lease)"]
scope: [tool]
interrupt: true
repeat: once
---

# Force-push must use --with-lease

Never run `git push --force` (or `git push -f`) without `--with-lease`. A blind
force-push overwrites teammates' commits if the remote has moved. Use
`git push --force-with-lease` (or `--force-with-lease=branch:remote/branch`) so
the push is rejected if the remote ref has advanced.

Note: `--force-with-lease` still counts as "force" for the CI-amend workflow —
it's the safe variant of force-push, not a replacement for it.
