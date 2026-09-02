---
name: no-empty-catch
astCondition: ["try { $$$ } catch ($E) {}", "try { $$$ } catch {}"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# No empty catch blocks

An empty `catch (e) {}` swallows errors silently — the app keeps running but
the failure is invisible. This is the most common agent error-handling
anti-pattern: the code "works" because it doesn't crash, but the bug is hidden.

At minimum, log or rethrow the error. If the error is genuinely expected and
ignorable, add a comment explaining why (`// expected: EADDRNOTAVAIL during
probe`) so the silence is intentional and documented.
