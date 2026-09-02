---
name: no-ts-any
condition: [":\\s*any\\b", "\\bas\\s+any\\b"]
scope: [tool]
interrupt: true
repeat: once
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# No TypeScript `any`

`: any` and `as any` punch a hole in the type system — the code compiles and
the error surfaces as a runtime crash weeks later. Agents reach for `any` when
they can't infer the correct type; that's exactly when you need the type most.

Use the correct type, or `unknown` if you genuinely don't know and narrow it
with a type guard. If you're interacting with an untyped third-party, declare a
proper interface rather than escaping with `any`.
