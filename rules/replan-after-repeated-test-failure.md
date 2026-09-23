---
name: replan-after-repeated-test-failure
condition: ["\\b(?:tests?|verifier|typecheck|build)\\b.{0,60}\\b(?:still fail(?:ing)?|failed again|fails again|same failure)\\b", "\\b(?:still fail(?:ing)?|failed again|fails again|same failure)\\b.{0,60}\\b(?:tests?|verifier|typecheck|build)\\b"]
verify: {"type":"noul","instructions":"Is the assistant about to repeat a fix/test cycle for an already-seen failure without stating a materially new cause or validation hypothesis?","threshold":0.84,"onFail":"suppress"}
scope: [text, thinking]
interrupt: true
repeat: once
---

# Re-plan instead of repeating a failed patch

On a repeated failure, inspect the first failing assertion and compare it with the requirement before editing again; state the new cause you are testing. After three unsuccessful attempts at the same check, stop patching and re-plan or escalate rather than spending more turns on near-identical changes.