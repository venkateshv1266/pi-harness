# scripts/ and bin/

Helpers that live outside the pi extensions: an opt-in installer for YubiKey
Git alerts, the Git wrappers it installs, the alert sounds, and a settings
migration that `./install.sh` runs for you.

| Path | What it does |
|---|---|
| `scripts/install-yubikey-notifications.sh` | Installs the YubiKey alert wrappers and default sound, then points Git at them |
| `scripts/migrate-jev-memory-settings.mjs` | Removes the legacy `npm:pi-hermes-memory` entry from `~/.pi/agent/settings.json` (run automatically by `./install.sh`) |
| `bin/git-gpg-yubikey-notify` | `gpg` wrapper that alerts before YubiKey signing operations |
| `bin/git-ssh-yubikey-notify` | `ssh` wrapper that alerts before Git SSH authentication |
| `bin/orca-focus-terminal` | Click-through helper: switches Orca to the exact terminal an alert came from |
| `sounds/yubikey-alert-2-beep.wav` | Default alert sound — the one the installer copies |
| `sounds/yubikey-alert-1-ascending.wav` | Alternate alert sound; not installed by any script — opt in via `PI_YUBIKEY_NOTIFICATION_SOUND` |

---

## YubiKey alerts for Git in cmux and Orca

If Git uses a YubiKey for SSH authentication or signing, the wrappers in
`bin/` fire a notification, an attention signal, and a sound just before the
touch is needed — inside cmux that's `cmux notify` plus `cmux trigger-flash`,
inside Orca a macOS notification banner plus the workspace unread dot. Run:

```bash
./scripts/install-yubikey-notifications.sh
```

The installer copies the wrappers and the default sound into `~/.pi/agent/`
(creating the `bin/` and `sounds/` directories if needed, marking the
wrappers executable), then points Git's global config at them:

| Installed file | Git setting |
|---|---|
| `~/.pi/agent/bin/git-gpg-yubikey-notify` | `gpg.program` |
| `~/.pi/agent/bin/git-ssh-yubikey-notify` | `core.sshCommand` |
| `~/.pi/agent/sounds/yubikey-alert-2-beep.wav` | — (default sound for both wrappers) |

Both settings are written with `git config --global`. The wrappers `exec`
the real `gpg`/`ssh` with all arguments, so Git behavior is unchanged apart
from the alert.

### Idempotency and existing settings

- Re-running the installer is safe: it re-copies the three files
  (overwriting its own previous copies) and skips any config key that
  already holds the target value.
- An existing custom value is never overwritten: if `gpg.program` or
  `core.sshCommand` already holds something else, the installer warns and
  leaves it unchanged. One exception — an existing `gpg.program` of plain
  `gpg` is replaced with the wrapper. `core.sshCommand` has no such
  exception: a pre-existing non-matching value blocks the SSH half until you
  clear it yourself.
- No backups are made; the protection against clobbering is the refusal to
  overwrite unfamiliar values, not a saved copy.

### What alerts when

- **SSH (`git-ssh-yubikey-notify`)**: fires before every Git SSH
  authentication — `fetch`, `pull`, `push`, and similar. SSH cannot reveal
  in advance whether the agent will demand a touch, so this may alert when
  an already-authenticated connection ends up not needing one.
- **GPG (`git-gpg-yubikey-notify`)**: fires only when the arguments request
  a signing operation — `--sign`, `--detach-sign`, `--clearsign`, or a short
  flag cluster containing `s`/`S`/`b` (Git passes clusters like `-bsau…`
  when signing commits and tags). Verification (`--verify`) stays silent.

Alerts fire only inside cmux or Orca; anywhere else the wrappers exec
straight through silently. Each wrapper checks for cmux (`CMUX_SOCKET_PATH`
or `CMUX_SOCKET` non-empty) or Orca (`TERM_PROGRAM=Orca` or
`ORCA_WORKTREE_ID` non-empty) and backgrounds the alert actions so the Git
operation is never delayed. Inside cmux those actions are `cmux notify
--title "YubiKey touch needed"` with an operation-specific body,
`cmux trigger-flash`, and `afplay` on the configured sound. Inside Orca they
are the same `afplay` sound, the workspace's sidebar unread dot via
`orca worktree set --unread`, and an Orca-branded banner via
`terminal-notifier -sender com.stablyai.orca` — falling back to a plain
`osascript` banner when terminal-notifier is not installed
(`brew install terminal-notifier`). The wrapper also pre-focuses the exact alerting
terminal inside Orca (`bin/orca-focus-terminal --no-open`, pane-level via
`ORCA_AGENT_PANE`), so clicking the banner activates Orca on that session's
terminal.

### Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_YUBIKEY_NOTIFICATION_SOUND` | `$HOME/.pi/agent/sounds/yubikey-alert-2-beep.wav` | Sound file both wrappers play via `afplay` (macOS). If the file does not exist, they fall back to `/System/Library/Sounds/Sosumi.aiff`. |
| `CMUX_SOCKET_PATH`, `CMUX_SOCKET` | unset | Presence (non-empty) is what enables cmux alerts. Expected to be provided by cmux inside its sessions; not meant to be set by hand. |
| `TERM_PROGRAM=Orca`, `ORCA_WORKTREE_ID` | unset | Either one non-empty enables Orca alerts. Provided by Orca inside its terminals; not meant to be set by hand. |
| `ORCA_AGENT_PANE`, `ORCA_TAB_ID` | unset | Orca's pane/tab ids, used to pre-focus the exact alerting terminal inside Orca. Provided by Orca automatically. |
| `ORCA_CLI_COMMAND` | `orca` | Orca CLI binary the wrappers call for the unread dot; Orca exports it in some managed environments, otherwise `orca` from `PATH` is used. |

### Uninstall / revert

```bash
git config --global --unset gpg.program      # only if it points at the wrapper
git config --global --unset core.sshCommand  # only if it points at the wrapper
rm ~/.pi/agent/bin/git-gpg-yubikey-notify \
   ~/.pi/agent/bin/git-ssh-yubikey-notify \
   ~/.pi/agent/sounds/yubikey-alert-2-beep.wav
```

Unsetting the two config keys restores Git's defaults (plain `gpg` and `ssh`
from `PATH`). The installed files and the config keys are independent —
removing one does not require the other, but leaving a config key pointing
at a deleted wrapper will break Git's signing/SSH until it is unset.

---

## migrate-jev-memory-settings.mjs

pi loads the `packages` array in `~/.pi/agent/settings.json` before the
extensions directory, so a leftover `npm:pi-hermes-memory` package entry
would claim the `memory_*` tool names and silently shadow the vendored
`jev-memory` extension. This script removes exactly that one entry and
touches nothing else in the file.

```bash
node scripts/migrate-jev-memory-settings.mjs
```

`./install.sh` runs it automatically as its last step. It is idempotent and
always exits 0: with no `settings.json` (or an unparsable one), no
`packages` array, or no legacy entry, it prints a "nothing to migrate"
message and changes nothing. It writes the file only when it actually
removes the entry, and it makes no backup. The memory store itself is
migrated separately and non-destructively by the jev-memory extension on
first pi start — see `../extensions/jev-memory/README.md`.
