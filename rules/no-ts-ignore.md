---
name: no-ts-ignore
condition: ["@ts-ignore", "@ts-nocheck", "eslint-disable"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# No @ts-ignore / eslint-disable to silence errors

Don't suppress a type or lint error with `@ts-ignore`, `@ts-nocheck`, or
`eslint-disable` — fix the underlying issue. Suppression hides the bug from
every future check and the next person has no idea why the line is ignored.

If a suppression is genuinely necessary (a known false positive), scope it to
the exact rule on the exact line (`// eslint-disable-next-line @typescript-eslint/no-explicit-any`) and add a comment explaining why.
Never use file-level `@ts-nocheck` or block-level blanket disables.
