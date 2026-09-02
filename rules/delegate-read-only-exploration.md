---
name: delegate-read-only-exploration
condition: ["(I'll|Let me|I will) explore the (repo|codebase|repository)"]
scope: [text, thinking]
interrupt: true
repeat: once
---

# Read-only repo exploration belongs in a subagent

When you announce an inline multi-pronged survey of the repo (structure + git history + README + package.json, etc.), you are about to pull large raw outputs into the main context for a task that needs only a compressed summary. Delegate instead: use the `explorer` agent (single mode) for "where is X / map this repo" lookups, or the `research` agent for open-ended investigation, and end the subagent prompt with "Return your findings as a structured summary." Keep quick single-file or single-command lookups inline — delegate only the broad surveys.
