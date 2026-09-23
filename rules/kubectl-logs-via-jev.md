---
name: kubectl-logs-via-jev
condition: ["\\bkubectl\\s+logs\\b"]
verify: {"type":"noul","instructions":"Will this kubectl logs command send a large or unbounded raw log stream directly into the model context, rather than use a small --tail window or save the output to a file?","threshold":0.8,"onFail":"degrade"}
scope: [tool]
interrupt: true
repeat: once
---

# Prefilter large kubectl logs with Jev

For an unbounded log dump, keep the existing Kubernetes pre-flight, save the raw output to a temporary file, then call `mcp__jev__jev_triage_log` with that file and a focused investigation question before reading the evidence. Jev only narrows and classifies the log; inspect its returned evidence and do the root-cause analysis yourself. A bounded `--tail` or file-redirection command should proceed without this interruption.