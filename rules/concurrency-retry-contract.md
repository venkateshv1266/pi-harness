---
name: concurrency-retry-contract
condition: ["\\b(?:exactly[- ]once|at[- ]least[- ]once|idempotenc\\w*|in[- ]flight|concurren(?:t|cy|tly))\\b"]
verify: {"type":"noul","instructions":"Is the current task changing asynchronous concurrency, idempotency, retry, or delivery semantics where behavior across overlapping calls or failures needs to be specified?","threshold":0.82,"onFail":"suppress"}
scope: [text, thinking]
interrupt: true
repeat: once
---

# Make concurrency and retry behavior explicit

Before coding, write down what happens for overlapping duplicates, an in-flight waiter, a failed attempt, a later retry, and success; test each applicable branch. In particular, decide whether a shared failed promise should reject concurrent callers and when claim/in-flight state is cleared instead of inheriting accidental `Promise.all` behavior.