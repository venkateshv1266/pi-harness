---
name: no-raw-log-dumps
condition: ["^read\\n[\\s\\S]*?\\.(log|out|ndjson|jsonl)\\b", "\\btools\\.read\\b[^\\n]{0,120}\\.(log|out|ndjson|jsonl)\\b", "pi-mcp-spillover", "\\b(cat|bat|less)\\b[^\\n]{0,80}\\.(log|out|ndjson|jsonl)\\b", "\\btail\\b[^\\n]{0,12}-[fF]", "\\b(journalctl|dmesg)\\b", "\\bgh\\s+(run\\s+watch\\b|run\\s+view\\b[^\\n]{0,120}--log|api\\b[^\\n]{0,200}/logs\\b)"]
scope: [tool]
interrupt: true
repeat: once
---

# Prefilter raw log dumps with triage_log before they hit context

Raw log output — reads of .log/.out/.ndjson/.jsonl files, cat/head/tail dumps, journalctl/dmesg, `gh run view --log` or `gh run watch` CI logs, and pi-mcp-spillover files — is unbounded context tax. Call the `triage_log` tool (ask-jev extension) with the file path and a focused investigation question first; inspect its returned evidence and do the root-cause analysis yourself. A small bounded peek (a few lines) can proceed without it.