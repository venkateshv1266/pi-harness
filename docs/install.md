# Installing

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js >= 22.15.0 | pi uses `zlib.createZstdDecompress`; older Node crashes at startup |
| pi >= 0.87.0 | the extensions use `turn_end` boundary results and `context_edit` drafts |
| git | clone and `update.sh` |
| rsync | macOS ships it; Linux needs `apt install rsync` |
| Bun (optional) | only for the `observatory` tests and server |

## The interactive flow

```bash
git clone https://github.com/venkateshv1266/pi-harness.git
cd pi-harness
./install.sh
```

The installer asks four things:

1. **What to install** — recommended (core + subagents), everything, custom (choose tiers), or inspect only.
2. **Model roles** — lists every provider it detects. Choose the OpenRouter preset if you use
   OpenRouter, pick per-role models from any other provider, keep your current settings, or skip.
3. **Jev layer** — whether to include the `jev` tier. It checks for `JEV_API_KEY` and warns instead of failing.
4. **Integrations** — per-component prompts for observatory, refine, and MCP auth hooks.

Nothing is written until the selection is confirmed.

## Flags

| Flag | Effect |
|---|---|
| `--yes` | accept defaults, no prompts |
| `--tier core,jev` | install entire tiers |
| `--only id,id` | install exact components (dependencies are added) |
| `--skip id,id` | remove components from the selection |
| `--add id,id` | add components to an existing install |
| `--dry-run` | print the plan and write nothing |
| `--list-models` | print detected providers and their available models, then exit |
| `--update` | re-apply the recorded selection |
| `--uninstall` | remove only what was recorded |
| `--ask` | re-run the wizard on an existing install |
| `--force-settings` | back up an unparseable `settings.json` and continue |
| `--target <dir>` | install somewhere other than `~/.pi/agent` (testing) |

## Model providers

The core tier needs no specific provider — it uses whatever pi is already logged into. The installer
detects providers from `~/.pi/agent/auth.json`, `~/.pi/agent/models-store.json`, a custom
`models.json`, and known provider API-key environment variables.

`./install.sh --list-models` prints what it found:

```text
openrouter — 361 model(s) available
  anthropic/claude-haiku-4.5
  anthropic/claude-opus-4.5
  …
```

The OpenRouter preset is offered only when OpenRouter is detected. For any other provider, the
installer lists that provider's models and asks for each role (`@smol`, `@slow`, `@plan`, `@task`).
If no provider is detected, model setup is skipped — run `/login` then `/roles` inside pi.

## What gets written

| Repo path | Destination |
|---|---|
| `extensions/…` | `~/.pi/agent/extensions/…` |
| `rules/*.md` | `~/.pi/agent/rules/` |
| `agents/*.md` | `~/.pi/agent/agents/` |
| `skills/…` | `~/.pi/agent/skills/` |
| `themes/*.json` | `~/.pi/agent/themes/` |
| `utils/…` | `~/.pi/agent/utils/` |
| `scripts/migrate-jev-memory-settings.mjs` | `~/.pi/agent/scripts/` |

The installer also writes `~/.pi/agent/.pi-harness.json`, a manifest of every file it created and
every settings key it set.

## Settings safety

- `settings.json` is backed up to `settings.json.bak.<timestamp>` before any write.
- The installer **aborts** if the file exists and cannot be parsed. It never replaces your settings
  with an empty object. `--force-settings` backs the file up and continues from `{}`.
- Existing keys are never overwritten. Model roles are added only when absent.
- `--uninstall` removes only the keys recorded in the manifest.

## Updating

```bash
./update.sh
```

It refuses to run with a dirty work tree, fast-forwards the repo, then re-applies the recorded
selection. Files you edited locally are preserved and reported; the repo version is written next to
them as `.bak.<timestamp>`. New components are listed, not installed automatically.

## Troubleshooting

- **`error: missing prerequisites: npm`** — install Node (npm ships with it).
- **`cannot parse settings.json`** — fix the JSON, or re-run with `--force-settings`.
- **A role resolves to nothing** — run `/setup` or check `model-roles` in `extensions/README.md`.
- **Jev tools do nothing** — `JEV_API_KEY` is not set in the environment pi was started from.
- **Observatory does not start** — it needs Bun: `bun run extensions/observatory/server.ts`.
