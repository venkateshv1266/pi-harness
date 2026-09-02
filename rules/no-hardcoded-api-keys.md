---
name: no-hardcoded-api-keys
flags: i
condition: ['(api[_-]?key|apikey|api[_-]?secret|client[_-]?secret|secret[_-]?key)\s*[:=]\s*["''][A-Za-z0-9_\-]{20,}["'']']
scope: [tool]
interrupt: true
repeat: once
---

# No hardcoded API keys / secrets

Never commit credentials as string literals in source — `apiKey = "sk-ant-..."`,
`client_secret: "..."`. Read them from environment variables, a secrets manager,
or a gitignored config. Hardcoded secrets leak via git history and are the most
common AI-coding-agent security finding (36-40% of generated code has one).

If this is a test fixture with a dummy value, put it in a `*.test.*` or
`__tests__/` file and use an obviously-fake value like `"test-key-not-real"`.
