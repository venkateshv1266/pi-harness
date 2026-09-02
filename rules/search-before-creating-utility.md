---
name: search-before-creating-utility
condition: ["[\\s\\S]"]
scope: [tool]
interrupt: false
repeat: once
globs: ["**/utils/**", "**/lib/**", "**/shared/**", "**/common/**", "**/helpers/**"]
---

# Search for an existing utility before creating a new one

You're writing to a shared-utils directory. Before adding a new validator,
helper, HTTP client, rate limiter, or wrapper, grep the repo for an existing
implementation: `rg -i "<concept-name>"`. Agents reimplement the same utility
4× because they don't search first. If one exists, use it — even if the API
isn't exactly what you'd write.
