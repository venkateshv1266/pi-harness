---
name: amend-ci-fixes
condition: ["git commit -m", "git commit --message", "git commit -am"]
scope: [tool]
interrupt: true
repeat: once
---

# Amend trivial CI fixes into the previous commit

For lint / prettier / formatting / type-error fixes that only address a CI
check failure, **always** `git commit --amend --no-edit` and
`git push --force-with-lease` (or `--force`). Do not create a separate commit
for a trivial CI fixup.

This keeps history clean: one logical change per commit. A standalone "fix
lint" commit is noise. The only exception is when the fix touches substantive
logic, not just formatting/types.
