# pi-harness

30 extensions · 9 subagent definitions · 22 generic TTSR rules · 5 skills · 3 themes

My [pi coding agent](https://github.com/earendil-works/pi-coding-agent) setup, published so other
people can borrow the pieces that work. It is a personal setup, not a product: some of it runs with
pi alone, and some of it needs a Jev API key, a model provider, or your own observability stack. The
installer asks before it installs those parts.

## Quick start

**Prerequisites**

- **Node.js >= 22.19.0** — pi's own minimum; older versions crash at startup.
- **pi >= 0.87.0** — `context_edit` and the actionable `turn_end` boundary landed there; tested
  with pi 1.4.0. Install with `curl -fsSL https://pi.dev/install.sh | sh` (recommended) or
  `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
- **git** and **rsync**. macOS has `rsync`; on Linux install it with your package manager.

**No OpenRouter key is required.** The `core` tier works with whatever provider pi is already
logged into. The installer only offers a model-role preset for providers it detects; for any other
provider it lists that provider's models and lets you pick per role. `./install.sh --list-models`
shows what it can see.

**Install**

```bash
git clone https://github.com/venkateshv1266/pi-harness.git
cd pi-harness
./install.sh
```

Press Enter on the recommended option and you get the `core` and `subagents` tiers. The installer
prints what it wrote, backs up `settings.json` first, and records the selection in
`~/.pi/agent/.pi-harness.json` so it can update or remove exactly those files later.

Then restart pi (or run `/reload`).

**Non-interactive**

```bash
./install.sh --yes                    # recommended defaults
./install.sh --tier core,jev          # pick tiers
./install.sh --only ttsr,todo         # pick components
./install.sh --dry-run                # show the plan, write nothing
./install.sh --list-models            # providers and models the installer can see
```

## What you get

| Tier | Contents | Needs |
|---|---|---|
| **core** (default) | TTSR rules engine and 22 rules, 9 agents, 5 skills, 3 themes, session UX (todo, recite, summarize, rewind, handoff, footer, guards, model roles and fallback, web search) | pi and Node |
| **subagents** | `delegate`, the one-shot engine, and the persistent engine | model roles configured |
| **jev** | Ask-Jev tools, memory, context curation, guard, course-check, decision tuner | `JEV_API_KEY` |
| **integrations** | Observatory dashboard, refine loop, MCP cookie/OAuth gate | your own Grafana / Redash / Snowflake / Linear / Orca setup |
| **local** | YubiKey notifications and terminal helpers | macOS and hardware; never installed by default |

The full feature → credential matrix is in [docs/compatibility.md](docs/compatibility.md).

## What is in the repo

| Path | What it is | Docs |
|---|---|---|
| `extensions/` | 30 pi extensions — delegation, models, judgment, memory, supervision, observability, session UX, integrations | [`extensions/README.md`](extensions/README.md) |
| `agents/` | 9 user-scope subagent definitions | [`agents/README.md`](agents/README.md) |
| `rules/` | 22 generic TTSR stream rules | [`rules/README.md`](rules/README.md) |
| `skills/` | add-rule, add-agent, add-mcp-server, code-review, orchestrate | [`skills/README.md`](skills/README.md) |
| `themes/` | 3 custom pi themes | [`themes/README.md`](themes/README.md) |
| `utils/` | Shared helpers: Jev client, role resolution, decision contract | [`utils/README.md`](utils/README.md) |
| `scripts/` | Installer core, settings migration, YubiKey notification setup | [`scripts/README.md`](scripts/README.md) |
| `docs/` | Concepts, install flags, compatibility matrix, maintainer notes | [`docs/README.md`](docs/README.md) |
| `harness.json` | Component manifest: tiers, dependencies, credentials | this file |

Common entry points:

- **Models** — [roles](extensions/README.md#model-roles), [route-ahead](extensions/README.md#model-router), [failover](extensions/README.md#model-fallback)
- **Delegation** — [delegate](extensions/delegate/README.md) with the [one-shot](extensions/subagent/README.md) and [persistent](extensions/persistent-subagent/README.md) engines
- **Judgment and guardrails** — [ask-jev](extensions/ask-jev/README.md), [jev-guard](extensions/jev-guard/README.md)
- **Memory and context** — [jev-memory](extensions/jev-memory/README.md), [jev-context-curator](extensions/jev-context-curator/README.md), [ttsr](extensions/ttsr/README.md), [recite](extensions/recite/README.md)
- **Settings UI** — [`/setup`](extensions/setup/README.md)
- **MCP servers** — [mcp-cookie-gate](extensions/README.md#mcp-cookie-gate) plus the [add-mcp-server](skills/add-mcp-server/SKILL.md) walkthrough. `~/.pi/agent/mcp.json` is yours to write; the repo never ships one.

## Updating

```bash
cd pi-harness
./update.sh
```

`update.sh` fast-forwards the repo, re-applies the components recorded in
`~/.pi/agent/.pi-harness.json`, keeps files you edited locally, and lists components added since
your install. Add one with `./install.sh --add <id>`. Re-run the wizard with
`./install.sh --ask`.

## Uninstalling

```bash
./install.sh --uninstall
```

That removes only the files and settings keys the installer recorded. Backups written before an
overwrite stay on disk (`.bak.<timestamp>`). Your own rules, agents, and extensions are untouched.

## Optional components

- **Jev judgment layer** — the `jev` tier needs `JEV_API_KEY` and `JEV_BASE_URL` in your environment.
  Without them those extensions stay inert; the rest of the harness is unaffected.
- **YubiKey alerts for Git in cmux and Orca** — `./scripts/install-yubikey-notifications.sh` wraps
  SSH and GPG so a hardware touch alerts. See [scripts/README.md](scripts/README.md).
- **Web search keys** — optional. Without keys the tools fall back to DuckDuckGo and Jina Reader.
- **Observatory** — `bun run extensions/observatory/server.ts` (or `/observatory`) serves a local
  dashboard over pi session and decision logs. It reads `~/.pi/agent`, so it only shows data you
  already have.

## Not included

- **`~/.pi/agent/mcp.json`** — your MCP server config. The repo ships no endpoints or credentials.
- **Most TTSR rule content** — `rules/` is the generic subset. Rules that reference employer
  infrastructure or internal docs stay local.
- **Project-local agents** (`.pi/agents/`) — those encode team workflows.
- **`auth.json`, `settings.json`, prompts, personal skills** — account and session state.

## Contributing

Bug reports and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first;
CI runs the manifest drift check and the Node + Bun test suites, and pull requests need one
maintainer review and a DCO sign-off.

## License

[MIT](LICENSE). Vendored components keep their original notices; `extensions/jev-memory` is derived
from `pi-hermes-memory` (MIT).
