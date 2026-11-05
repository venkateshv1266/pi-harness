---
name: "pi-upgrade-review"
description: "Review a pi version bump (e.g. 1.4 → 1.5) for breaking changes, per-extension impact with file:line evidence, stale vendored deps, dead model ids, and harness improvement opportunities — report only, the user decides what to fix."
version: 1
created: "2026-11-05"
updated: "2026-11-05"
---

## When to Use

Run after `pi update`, after installing a new `@earendil-works/pi-coding-agent`, or whenever asked "what changed in pi X.Y / does the upgrade break my harness". Run it before syncing or committing harness changes so the report and the fixes stay separate steps.

## Procedure

1. Capture the version delta: `pi --version` for the new version; find the previous version in `~/pi-harness/CHANGELOG.md` or the last release you reviewed. Installed changelog: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`.
2. List release headings and read ONLY the new section: `grep -n '^## \[' CHANGELOG.md | head -5` gives the bounds. Read the new release in slices of ≤45 lines, always piped through `cut -c1-400`, e.g. `sed -n '12,34p' CHANGELOG.md | cut -c1-400`. Changelog bullets are multi-KB single lines; unfiltered reads get truncated and lose the middle.
3. For every bullet under `### Breaking Changes`, write the concrete grep that decides whether the harness is exposed and run it:
   - JSON-Schema-only validation → `rg -n 'Type\.Refine|Type\.BigInt|Type\.Undefined|Type\.Void|Type\.Codec|Type\.Transform|Format\.Set' extensions utils`
   - pi-ai TypeBox re-export removal → `rg -n '\bType\b.*from "@earendil-works/pi-ai"' extensions utils` (runtime is mapped inside pi, the published types are not)
   - keybinding helpers → `rg -n 'keyText|keyHint'`
   - `pi.exec` cap/kill changes → `rg -n 'pi\.exec\(' -A10`
   - `setActiveTools` → `rg -n 'setActiveTools'`
   - MCP OAuth → `rg -n 'clientId|clientName|callbackUrl|clientRegistration' ~/.pi/agent/mcp.json`
4. Typecheck A/B against old and new pi types. pi-harness has no typecheck script, so a raw tsc over an explicit file list is the sanctioned path (never repo-wide). Scratch config: `moduleResolution bundler`, `allowImportingTsExtensions`, `strict`, `skipLibCheck`, `noEmit`; paths for `@earendil-works/pi-coding-agent` → `<pi>/dist/index.d.ts`, `@earendil-works/pi-ai`, `pi-tui` and `pi-agent-core` → `<pi>/node_modules/@earendil-works/<pkg>/dist/index.d.ts` (nested!), `typebox` → `<pi>/node_modules/typebox/build/index.d.ts`; files = the live extensions that import pi packages. Run `./node_modules/.bin/tsc -p /tmp/tc/tsconfig.json 2>&1 | grep -v 'node_modules/'`, then repeat with the paths rewritten to the previous version's vendored copy (`extensions/jev-memory/node_modules/@earendil-works/...`) and diff: only errors new to the upgraded types are regressions.
5. `npm run check:models` — resolves every pinned id (settings.json model keys, `modelFallback`/`modelThinkingLevels`/`modelRouter`, harness presets, agent frontmatter) against `pi --list-models`. Manual fallback: dump `pi --list-models > /tmp/pi-models-<ver>.txt` once and match the provider and model COLUMNS (not substring); confirm each miss with `pi --list-models <model>` before reporting, because the resolver falls back across providers.
6. `npm run check:deps` — compares every vendored `@earendil-works/*` install and declared range under both `~/.pi/agent/extensions` and `~/pi-harness/extensions` to `pi --version`. A stale local copy wins module resolution, so runtime imports (`getAgentDir`, `CONFIG_DIR_NAME`, `parseFrontmatter`, `getMarkdownTheme`, `StringEnum`, `keyHint`) come from the old pi.
7. Run the gates: `npm run check:manifest`, `npm run test:node`, `npm run test:bun` (say so if Bun is missing), and `npm run check:upgrade`.
8. Report, without editing: (1) breaking changes and whether each applies, with the grep evidence; (2) impact table with `file:line` + severity for real breakage; (3) verified-not-affected list with evidence; (4) improvement opportunities from the release's Added section mapped onto harness files; (5) proposed fix batches, one concern per commit. Ask the user which batches to take.
9. After approval only: edit the live `~/.pi/agent` copies first, re-run the gates, then `./sync.sh` live → mirror (rsync `--delete`, so repo-only edits get reverted), verify with `cmp`, and commit one concern per commit.

## Pitfalls

- pi changelog bullets are multi-KB single lines: always `cut -c1-400` plus narrow `sed` ranges.
- `rg -r` is `--replace`, not recursive — never bundle it with other short flags.
- Do not run a repo-wide tsc: it floods with pre-existing `node_modules` errors. Raw tsc on an explicit file list is correct here; filter `node_modules/` and judge first-party errors only.
- A scratch tsconfig without `typebox` and `pi-agent-core` path mappings reports false `TS2307` for extension deps that live in per-extension `node_modules`.
- tsc must point at the NESTED `pi-ai`/`pi-tui`/`pi-agent-core` under `pi-coding-agent/node_modules`, not the top-level global install (only `pi-coding-agent` is top-level).
- Live `~/.pi/agent/extensions/jev-memory/node_modules/@earendil-works` can be an empty dir while the mirror holds real copies — `check:deps` covers both roots; keep it that way.
- Do not delete vendored `node_modules` to clear drift: extension packages declare pi as devDeps for their own typecheck; bump the range and reinstall instead.
- A missing model id is a broken role, not cosmetic: the 1.5 catalog moved to models.dev v2 and retired `meta/muse-spark-1.3` while keeping its siblings.
- `sync.sh` copies live → mirror with `--delete`: make every harness edit on the live copy first, then stage only the intended files (live drift lands in the mirror working tree).
- Never auto-apply fixes found by this review — the report is the deliverable, the user picks the batches.

## Verification

1. Every bullet under the new release's Breaking Changes is listed with an explicit applies / does-not-apply verdict plus the command that proved it.
- Each flagged finding cites `file:line` and was confirmed by a command (grep, `pi --list-models`, `npm run check:upgrade`, or a tsc A/B where the error is absent on the old types).
- The report includes a verified-not-affected section so coverage is visible, not just problems.
- Nothing is edited before the user approves the fix batches.
- After any approved fix: `npm run check:manifest`, `npm run test:node` (and `test:bun` where available), `npm run check:upgrade` pass; `cmp` confirms live and mirror match; `git status` shows only the intended files.
