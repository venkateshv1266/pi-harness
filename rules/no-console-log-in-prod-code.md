---
name: no-console-log-in-prod-code
astCondition: ["console.log($$$)"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.js"]
---

# No console.log in production code

Don't leave `console.log` debugging statements in committed code. Use the
project's logger, or remove the call before committing.
