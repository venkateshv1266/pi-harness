---
name: no-console-log-prose
condition: ["let me add a (?:console\\.log|print) to (?:debug|check)", "I['']ll just (?:log|print) (?:this|it) (?:for now|to see)", "let me (?:log|print) (?:this|it) to see"]
scope: [text]
interrupt: true
repeat: once
---

# Don't announce throwaway debug logging

You just said you're adding a `console.log` / `print` "to check" or "for now" —
that debug statement will be committed and forgotten. Agents announce debug
logs constantly and almost never remove them.

If you need to debug, use the project's logger at `debug` level (which is
filterable and won't ship to prod), or add the print, verify, and **remove it
before the change is done**. Do not leave "just to see" logging in committed
code.
