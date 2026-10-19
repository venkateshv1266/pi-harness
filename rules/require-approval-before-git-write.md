---
name: require-approval-before-git-write
condition: ["\\bgit\\s+(?:-\\S+\\s+\\S+\\s+)?(?:commit|push)\\b"]
verify: {"type":"noul","instructions":"Should this approval rule fire? Answer yes ONLY when BOTH hold. (a) The TOOL CALL really runs a git commit or push — not stash (including 'git stash push'), pull, fetch, status, diff, log, or a git command merely quoted in echo output, docs, or prose. (b) No approval is evidenced: LAST USER MESSAGE does not tell the agent to commit/push (e.g. 'commit it', 'push', 'go ahead and commit and push', 'ship it'), and neither the goal nor its constraints pre-approve the write. If the user already gave the go-ahead, answer no.","threshold":0.8,"onFail":"degrade"}
scope: [tool]
interrupt: true
repeat: once
flags: i
---
Before executing this git commit or push, verify the user explicitly approved it. Otherwise stage/show the relevant diff and stop.

If the user already told you to commit or push in this session — or the standing
instruction covers it — proceed without asking again; do not re-confirm an
approval you already have.

`git stash`, `git pull`, `git fetch`, and other non-history-writing commands do NOT require approval.
