---
name: no-temp-fixes
condition: ["// (HACK|FIXME|temporary)", "TODO: temporary", "for now", "quick fix", "workaround for now"]
scope: [text, tool]
interrupt: true
repeat: once
---

# No temporary fixes — find root causes

Don't leave `// HACK`, `// FIXME: temporary`, "for now", or "quick fix"
workarounds in the code. Find the root cause and implement the real fix. Senior
developer standards — no laziness.

If a temporary fix is truly unavoidable (a upstream blocker, a hotfix window),
write a linked ticket and a concrete follow-up plan in the comment. Never ship
a "for now" without an explicit next step.
