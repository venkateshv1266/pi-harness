---
name: no-localhost-in-prod-code
condition: ["(?:https?://)?(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):"]
scope: [tool]
interrupt: false
repeat: once
---

# No hardcoded localhost in non-dev code

Hardcoded `localhost:3000` / `127.0.0.1:8080` URLs fail the moment the code
runs anywhere other than the developer's machine. Read host/port from config or
environment variables.

This is a reminder, not a block — localhost is legitimate in dev scripts,
`vite.config`, and local test setups. But in application source, service
clients, or webhook URLs, replace it with a config-driven value.
