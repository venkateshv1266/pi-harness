# <Extension name>

> One-line summary of what this extension does.

<!--
TEMPLATE RULES — read before writing, delete this comment block in the final doc.

- Replace every <...> placeholder. Keep only the sections that apply; drop the rest.
- Factual accuracy is the whole job. Every command, tool, setting key, env var,
  file path, and default MUST be read from the extension's code — never invented
  or guessed from the root README.
- Proportional length: a 50-line extension gets ~20 lines of docs, not 100.
- Style: terse factual prose; tables for commands and configuration. Match the
  tone of the existing docs (extensions/ttsr/README.md, extensions/jev-memory/README.md).
- Paths: use `~/.pi/agent/...` and repo-relative paths. Never absolute machine
  paths, usernames, employer names, internal URLs, or secrets.
- Cross-reference sibling extensions with relative links, e.g.
  `../jev-memory/README.md`.
- If something cannot be determined from the code, write "not documented in
  code" and flag it in your return summary — do not guess.

Placement:
- Directory extension  -> <dir>/README.md
- Single-file extension -> a `## <name>` section in extensions/README.md (no separate file)
-->

## What it does

2–5 sentences on the problem it solves and what the user sees. Lead with the
user-visible surface (command, tool, status line), then the mechanism.

## Commands and tools

| Command / tool | What it does |
|---|---|
| `/command` | … |
| `tool_name` | … |

Drop this section if the extension registers no commands or tools.

## Configuration

Settings written to `~/.pi/agent/settings.json` and/or environment variables.
Include defaults.

| Key / env var | Default | Effect |
|---|---|---|
| `someSetting` | `true` | … |
| `SOME_ENV` | unset | … |

State in `~/.pi/agent/<something>/` also belongs here (what is stored, when).

## How it works

Only when the behavior is non-obvious: which pi hooks/events it uses, state
files, lifecycle, and interactions with other extensions. Explain *why* where
the code encodes a deliberate design choice; do not narrate code line by line.

## Caveats

Known limits, failure modes, when it silently no-ops, and manual steps users
must remember (e.g. required `/reload`).
