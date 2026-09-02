---
name: verify-before-done
condition: ["\\bI(?:'m| am|'ve| have) (?:done|finished|completed)\\b", "\\bthe task is (?:complete|done|finished)\\b", "\\bthat(?:'s| is) (?:done|complete|finished)\\b"]
scope: [text]
interrupt: true
repeat: once
---

# Verify before claiming done

You just said you're done — have you verified? Before declaring complete: run
lint + typecheck (check package.json scripts), run the tests touching the
changed code, and confirm you didn't break existing functionality. "Would a
staff engineer approve this?" A change isn't done when it compiles; it's done
when it's verified.
