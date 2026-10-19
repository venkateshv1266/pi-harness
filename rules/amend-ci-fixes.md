---
name: amend-ci-fixes
condition: ["\\bgit\\s+commit\\b"]
verify: {"type":"noul","instructions":"Should the amend rule fire? Answer yes ONLY when BOTH hold. (a) A pull request is already raised for this work: SESSION GIT CONTEXT shows pr=#N, or the session contains a PR URL / gh pr create output / gh pr view output for the current branch, or LAST USER MESSAGE clearly asks to update an open PR. (b) The TOOL CALL creates a plain new commit and does NOT already use --amend. Answer no when branch shows pr=none-seen-in-session and nothing else evidences an open PR (a first commit on a fresh branch is not a fixup), and no when the command already has --amend.","threshold":0.8,"onFail":"suppress"}
scope: [tool]
interrupt: true
repeat: once
---
Once a PR is raised, the branch keeps **one commit per PR**. Any follow-up
fix — lint, prettier, formatting, type errors, CI failures, review comments —
goes onto that PR's existing commit:

```bash
git commit --amend --no-edit
git push --force-with-lease
```

Never stack a standalone "fix lint" commit on top of a raised PR, and never
use a plain `--force` push.

Before the PR exists, commit normally — the first commit is not a fixup, and
this rule should not fire. Substantive new logic (not a fixup to the same
change) also deserves its own commit rather than an amend.
