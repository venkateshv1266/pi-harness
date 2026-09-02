---
name: no-prod-migrations-local
condition: ["migrate(:?\\s+\\S+)*.*(--mode\\s*=?(prod|production)|NODE_ENV=prod|prod)", "NODE_ENV=production.*migrate"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.sh", "**/*.ts", "**/*.js"]
---

# Never run production migrations locally

Do not run database migrations against production (`--mode=prod`,
`NODE_ENV=production`, etc.) from a local shell. Use the dedicated ops job /
CI pipeline. If you need to test a migration, run it against a local or
testnet database.
