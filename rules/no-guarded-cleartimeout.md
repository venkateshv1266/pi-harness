---
name: no-guarded-cleartimeout
astCondition: ["if ($X) clearTimeout($X)"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.js"]
---

# Don't guard clearTimeout with the same variable

`if (timer) clearTimeout(timer)` is redundant: if the handle is falsy the call is
already a no-op, and if it's valid the guard is dead code. Call
`clearTimeout(timer)` directly, or guard with a distinct sentinel
(`let pending: ReturnType<typeof setTimeout> | null`).
