---
name: no-placeholder-api-key
condition: ['["''](?:YOUR|PLACEHOLDER|REPLACE|INSERT|XXX|EXAMPLE|TEST)[_A-Z]*(?:API_)?(?:KEY|TOKEN|SECRET)[_A-Z]*["'']']
scope: [tool]
interrupt: true
repeat: once
---

# No placeholder API keys

Don't ship `"YOUR_API_KEY"`, `"PLACEHOLDER_TOKEN"`, `"XXX_SECRET"` literals as
the actual value passed to a client or request. The call will fail silently at
runtime and the user won't know why (the classic "API integration failure" —
the app looks like it works but returns a hardcoded fallback).

Either read the real value from the environment and fail loudly if it's missing,
or ask the user for the key before wiring up the call. Never leave a placeholder
as the production value.
