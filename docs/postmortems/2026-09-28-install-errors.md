# Postmortem: `install.sh` errors — pi failed to start, then failed silently

- **Date:** 2026-09-28
- **Scope:** `install.sh`, `extensions/jev-memory`, `extensions/recite`, vendored `extensions/cmux-session.ts`
- **Status:** all fixes applied and verified on this branch; see [Verification](#verification).

## Preface

This repo (`my-pi-setup`) syncs a personal pi coding-agent configuration: `install.sh` copies extensions, themes, TTSR rules (a runtime rule-stream engine), subagent definitions, and skills from this repo into `~/.pi/agent/`. Pi (the `@earendil-works/pi-coding-agent` CLI) then auto-loads everything in `~/.pi/agent/extensions/` at startup.

The problem this note solves: after running `./install.sh`, pi either refused to start at all, or started but behaved subtly broken (non-interactive `pi -p` printed nothing; every session emitted five hook-failure warnings). This note records the root causes, the fixes, the evidence, and the sharp edges left behind.

## TL;DR

- **pi could not start at all:** the `jev-memory` extension imports the npm package `strip-ansi` but never declared it as a dependency, so `npm install` never installed it and pi aborted on the first failed extension load. **Fixed** by declaring the dependency.
- **`pi -p` (non-interactive print mode) silently printed nothing:** the `recite` extension appends a state-recitation entry after every assistant reply; pi's text print mode only prints output if the *last* session message is the assistant's reply. **Fixed** by skipping recitation in print mode.
- **Five `cmux hook command failed` warnings every session:** `install.sh` unconditionally reinstalled a vendored `cmux-session.ts` bridge whose hooks call the `cmux` binary — which is not installed on this machine. **Fixed** by making the installer skip it (and remove stale copies) when `cmux` is absent from `PATH`.
- **Install failures were invisible:** `install.sh` ran `npm install --silent`, which hides even error text, so a failed install would kill the script with no message. **Fixed** with a verbose re-run on failure.
- **Caveats:** several extensions import across extension boundaries (`../subagent/agents.ts`, `../../utils/*`). A full install works, but deleting any single dependency makes pi abort at startup. Left as-is; see [Open questions](#close).

## Body

### 1. pi refused to start: undeclared `strip-ansi` dependency in `jev-memory`

`jev-memory` is a hybrid markdown + SQLite memory extension vendored into this repo. Its `src/tools/shared-output-view.ts:2` has a top-level `import stripAnsi from "strip-ansi"`, but the extension's `package.json` declared only `better-sqlite3` and `typebox`. Because `install.sh` runs `npm install` per extension, the package was simply never present.

Every pi launch then aborted with the first of these errors (pi hard-aborts on a single failed extension):

```
$ pi -p
Error: Failed to load extension "~/.pi/agent/extensions/jev-memory/src/index.ts":
Failed to load extension: Cannot find module 'strip-ansi'
Require stack:
- ~/.pi/agent/extensions/jev-memory/src/tools/shared-output-view.ts
Hint: Start without extensions using "pi -ne".
```

**Fix** (`extensions/jev-memory/package.json`): added `"strip-ansi": "^7.1.0"` to `dependencies`. **VERIFIED** — after reinstall, pi starts and the extension loads.

### 2. `recite` broke non-interactive print mode

`recite` is a "tail recitation" extension: after every completed turn it appends a compact goal/todo state block as a *context-only* custom entry, so the session goal sits at the most-attended tail position of the model's context (`extensions/recite/index.ts`, `turn_end` handler).

The interaction failure is in pi's text print mode, which only prints output when the **very last** session message has `role: "assistant"` — verbatim from pi's installed source, `dist/modes/print-mode.js:113-118` (pi 0.87.1):

```js
const lastMessage = state.messages[state.messages.length - 1];
if (lastMessage?.role === "assistant") {
    ...
    for (const content of assistantMsg.content) {
        if (content.type === "text") writeRawStdout(`${content.text}\n`);
    }
}
// no else-branch: anything not last-and-assistant prints nothing
```

Recite's appended entry lands *after* the assistant reply, so `pi -p` printed zero bytes and exited 0 — silent failure. This matters beyond piping convenience: extensions that compose child agents must keep non-interactive modes functional; pi's own docs state this contract at `docs/extensions.md:194` ("Keep tool and event behavior independent from rendering so non-interactive modes remain functional"). (The `subagent`/`persistent-subagent` extensions spawn children as `pi --mode json -p --no-session` — `extensions/subagent/index.ts:210` — which use the JSON event stream, not the last-message rule, so subagents were unaffected; **VERIFIED** by direct test. Human-facing `pi -p` text mode was broken.)

Bisect method: with all extensions loaded, `-p` was empty; with `-ne` (no extensions) it printed the reply. Moving extension subsets in and out of `~/.pi/agent/extensions/` isolated the breaker to `recite` alone — removing only `recite` restored output while every other extension stayed.

**Fix** (`extensions/recite/index.ts`): the `turn_end` handler now returns early when `ctx.mode === "print"` (the `ExtensionMode` type pi exposes to extensions is `"tui" | "rpc" | "json" | "print"` — `dist/core/extensions/types.d.ts:209`). Recitation is worthless in print mode anyway: each `pi -p` run is one-shot, so nothing follows the final turn to attend to the tail. Interactive (TUI), RPC, and JSON behavior unchanged. **VERIFIED**:

```
$ echo "Reply with the single word OK." | pi -p --no-tools
OK
```

### 3. `cmux-session.ts` warned on every session event

`cmux` is a terminal-multiplexer tool; `cmux-session.ts` is a bridge extension that reports pi's lifecycle events to it. The file is *managed by cmux* ("Installed by `cmux hooks pi install` … DO NOT EDIT MANUALLY" — `extensions/cmux-session.ts:2-3`) and this repo vendors a copy. `install.sh` rsynced it unconditionally.

The `cmux` binary is not installed on this machine (`command -v cmux` → not found; **VERIFIED**), so every session emitted:

```
{"source":"cmux-pi-extension","level":"warning","message":"cmux hook command failed",
 "subcommand":"session-start","status":null,...}   (and prompt-submit, notification, stop)
```

The README already said "Skip it if you don't use cmux" — but nothing enforced it, and a fresh `install.sh` run reinstalled the file even if you deleted it by hand.

**Fix** (`install.sh`, step 1): when `cmux` is not on `PATH`, the installer excludes `cmux-session.ts` from rsync and removes any stale installed copy; when `cmux` is present, behavior is unchanged. The README table row was updated to document the automatic skip. **VERIFIED** — post-install `ls ~/.pi/agent/extensions | grep -c cmux` → 0, and the warnings are gone from stderr.

### 4. `install.sh` hid npm failures

`install.sh` ran `npm install --silent` per extension in a `set -euo pipefail` script. `--silent` suppresses *all* npm output, including error text — a failed install would abort the script mid-loop with no explanation. (This is also how issue 1 stayed invisible for so long: warnings about npm's script-blocking, see below, never surfaced either.)

**Fix** (`install.sh`): on failure the installer now prints `error: npm install failed in <dir>` and re-runs npm verbosely so the cause is visible, then exits 1. Also added `--no-fund --no-audit` to cut noise. **VERIFIED** by inspection of the new control flow; no failure occurred in the post-fix install run.

### Benign warnings you may still see (no action required)

npm ≥ 11.5's allowScripts security feature blocks undeclared install scripts. On a verbose `npm install` these appear:

- `better-sqlite3 (install: node-gyp rebuild)` — **benign.** better-sqlite3 v13 ships prebuilt platform binaries in `prebuilds/` and loads them without running the install script. **VERIFIED**: `node -e "require('better-sqlite3')"` in the installed extension succeeds.
- `protobufjs (postinstall)` — a runtime-version check, not a build step. **ASSUMED** benign from the script's name/purpose; no runtime failure observed.
- `@google/genai (preinstall: echo 'preinstall: no-op')` — literally a no-op. **VERIFIED** from the warning text itself.

### Verification

Full matrix run after the fixes, on this branch:

| Check | Command | Result |
|---|---|---|
| Installer clean | `./install.sh` | exit 0, no warnings |
| Text print mode | `echo "…OK." \| pi -p --no-tools` | prints `OK` (was: 0 bytes) |
| JSON print mode (subagent child path) | `pi --mode json -p --no-session` | streams events incl. assistant message, clean stderr |
| Recite unit tests | `node --test extensions/recite/compose.test.ts` | 0 failures |
| Whitespace check | `git diff --check` | clean |
| cmux file gone | `ls ~/.pi/agent/extensions \| grep -c cmux` | 0 |

## Close

### Risks

- The `strip-ansi` fix works only until another undeclared import slips in. The same audit that found it also surfaced `persistent-subagent/index.ts:41` importing `typebox` without declaring it — currently resolved by pi providing it as an ambient module, which **ASSUMED** continues to hold across pi versions.
- The print-mode guard depends on pi's documented `ctx.mode`; a rename in a future pi release would silently re-break print mode (failure mode: empty `-p` output again, easy to spot).

### Open questions (human decisions)

- **Cross-extension imports make the set non-decomposable.** `decision-tuner` imports `../decisions-report.ts` and `../../utils/*`; `delegate` imports `../subagent/*`, `../persistent-subagent/*`, and `../jev-memory/src/jev/client.ts`; `setup` imports `../model-router.ts`; `model-router` imports `./model-fallback.ts`; `persistent-subagent` imports `../subagent/agents.ts`. All resolve in a **full** install, but pi hard-aborts on any missing piece — so a user deleting one extension can brick pi startup entirely. Decouple (self-contained extensions or explicit install manifests), or document "install everything or nothing" as the contract?
- Is cmux gone for good, or should the vendored `cmux-session.ts` be removed from the repo entirely rather than conditionally skipped at install time?

### Proposed follow-ups

- Add a post-install smoke test to `install.sh` (`pi -p` one-liner; abort if stdout is empty) — this exact failure class would then be caught by the installer itself.
- Add a lint step that diffs each extension's bare imports against its `package.json` dependencies (the manual audit in this investigation is checked in nowhere).

## Appendices

### Alternatives considered

| Decision | Alternative | Why rejected |
|---|---|---|
| Guard recite on `ctx.mode === "print"` | Fix pi: print mode scans backward for the last assistant message | pi is an installed upstream product; patching `dist/` would be overwritten on update, and print mode's contract ("print the reply") is arguably satisfied — the extension violated the documented non-interactive contract |
| Guard recite on print mode only | Also skip `json` mode | Subagents consume the JSON event stream, not the last message; recitation entries there are harmless. No observed failure in JSON mode (**VERIFIED**) |
| Skip `cmux-session.ts` when `cmux` absent | Delete the vendored file from the repo | The file is cmux-managed and the user may reinstall cmux; conditional skip keeps the repo generic and reversible. Deleting remains the open question above |
| Declare `strip-ansi` in package.json | Vendor the dependency / inline the function | Declaring is the standard contract `npm install` already implements in `install.sh`; vendoring adds drift risk |

### Domain primer

- **pi** — the coding agent CLI (`@earendil-works/pi-coding-agent`); loads extensions from `~/.pi/agent/extensions/` at startup and hard-aborts on the first extension that fails to load. Docs: `docs/extensions.md` in the pi package; project: <https://github.com/earendil-works/pi-coding-agent>.
- **Extension** — a TypeScript file or directory pi loads at runtime; extensions receive an `ExtensionAPI` and an `ExtensionContext` whose `mode` field is `"tui" | "rpc" | "json" | "print"`.
- **`pi -p` (print mode)** — non-interactive one-shot mode: process a prompt, print the reply to stdout, exit. Text mode prints only if the last session message is the assistant reply; `--mode json` emits a newline-delimited event stream instead.
- **TTSR** — the rule-stream engine this repo installs into pi (`extensions/ttsr/`); not involved in any failure here.
- **allowScripts** — npm ≥ 11.5 security feature that blocks packages' install scripts unless explicitly approved; source of the benign warnings above. Explainer: npm docs on scripts (`https://docs.npmjs.com/cli/v11/using-npm/scripts`).
- **rsync** — file-sync utility `install.sh` uses to copy this repo's extensions/themes/rules into `~/.pi/agent/` idempotently.

### Glossary

| Term | Meaning |
|---|---|
| cmux | Terminal-multiplexer tool that the vendored `cmux-session.ts` bridges pi events into |
| context-only entry | A session entry added for model context that is not a rendered chat message |
| hard-abort | pi exits at startup if any single extension fails to load |
| one-shot | A `pi -p` invocation that processes its prompt and exits; contrasted with retained "persistent" subagent sessions |
| prebuild | A native binary shipped inside the npm package so no compile step is needed at install time |
| tail recitation | recite's technique: re-emit the goal/todo block at the tail (most-attended position) of the model's context every turn |
| vendored | Third-party code copied into this repo rather than installed from a registry |
