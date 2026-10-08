---
name: ask-jev-for-file-judgments
condition: ["^read\\n"]
verify: {"type":"noul","instructions":"Is this read a judgment lookup — answering a yes/no, which-one, classification, or risk/quality question about the file's content (or examining a large log) that ask_jev_file_* or triage_log tools could handle — rather than opening code the model needs to edit, quote verbatim, or follow as instructions?","threshold":0.8,"onFail":"suppress"}
scope: [tool]
interrupt: true
repeat: once
---

# Judgment questions about files belong in ask-jev, not reads

When you need a yes/no, which-one, classification, or how-risky judgment about a file's content, call the ask-jev tools instead of reading the file: ask_jev_file_bool / ask_jev_file_choice / ask_jev_file_score for one file, ask_jev_files + pick_first_file to find where to start in an unfamiliar tree, triage_log before reading any large log. Reserve `read` for code you are about to edit or quote, and grep for exact-string lookups.