---
name: no-console-log-in-prod-code
condition: ["\\bgit\\s+commit\\b"]
scope: [tool]
interrupt: true
repeat: once
verify: {"type":"noul","instructions":"Does the session context (recent file writes/edits, known facts) indicate that code about to be committed still contains console.log debugging statements — excluding console.error/console.warn and the project's logger?","threshold":0.85,"onFail":"suppress"}
---

# No console.log in production code

A commit is about to run and the session context suggests `console.log` debugging
statements are still in the changed code. Before committing, run
`git diff --staged -U0 | grep -n 'console\.log'`; if any are found, remove them or
switch to the project's logger, stage again, then re-commit.
