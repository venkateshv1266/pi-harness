#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="${HOME}/.pi/agent"
BIN="${AGENT}/bin"
SOUNDS="${AGENT}/sounds"
GPG_WRAPPER="${BIN}/git-gpg-yubikey-notify"
SSH_WRAPPER="${BIN}/git-ssh-yubikey-notify"

mkdir -p "$BIN" "$SOUNDS"
cp "$REPO_DIR/bin/git-gpg-yubikey-notify" "$GPG_WRAPPER"
cp "$REPO_DIR/bin/git-ssh-yubikey-notify" "$SSH_WRAPPER"
cp "$REPO_DIR/sounds/yubikey-alert-1-ascending.wav" "$SOUNDS/yubikey-alert-1-ascending.wav"
chmod 755 "$GPG_WRAPPER" "$SSH_WRAPPER"

configure_git_value() {
  local key="$1"
  local value="$2"
  local current
  current="$(git config --global --get "$key" || true)"
  if [ -z "$current" ] || [ "$current" = "$value" ] || { [ "$key" = "gpg.program" ] && [ "$current" = "gpg" ]; }; then
    git config --global "$key" "$value"
  else
    printf 'warning: leaving existing %s=%s unchanged\n' "$key" "$current" >&2
  fi
}

configure_git_value gpg.program "$GPG_WRAPPER"
configure_git_value core.sshCommand "$SSH_WRAPPER"

printf 'Installed YubiKey Git notifications.\n'
printf '  gpg.program=%s\n' "$(git config --global --get gpg.program)"
printf '  core.sshCommand=%s\n' "$(git config --global --get core.sshCommand)"
printf '  sound=%s\n' "$SOUNDS/yubikey-alert-1-ascending.wav"
