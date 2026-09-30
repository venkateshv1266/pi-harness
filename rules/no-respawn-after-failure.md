---
name: no-respawn-after-failure
condition: ['\bre-?spawn(ing|ed)?\b', '\b(re-?run|rerun|re-?start)[^\n]{0,40}\b(review|fan-?out|full flow|verification)\b', '\bspawn (a|another|the) (new|fresh) (reviewer|verifier|research|writer|subagent|agent)\b', '\b(re-?run|rerun|run)[^\n]{0,40}from scratch\b']
scope: [text, thinking]
interrupt: true
repeat: once
verify: {"type":"noul","instructions":"Is this about re-spawning or re-running a failed subagent's completed work instead of resuming the retained session — not quoting, discussing, or documenting the anti-pattern?","threshold":0.8,"onFail":"fire"}
---

# Re-spawning a failed subagent instead of resuming it

When a delegated subagent (or one of its nested agents) fails, aborts, or returns a partial result, do not re-spawn a fresh child or re-run the whole flow — that repeats all completed work and the user has said this is not intended. Check `subagent_list` for the retained handle and resume it: `subagent_wait` auto-resumes an aborted run; `subagent_send` retries only the failed piece in the same session. A fresh `delegate` spawn is a last resort after 2 failed resume/steer attempts.