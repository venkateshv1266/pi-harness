#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="${HOME}/.pi/agent"
BIN="${AGENT}/bin"
SOUNDS="${AGENT}/sounds"
GPG_WRAPPER="${BIN}/git-gpg-yubikey-notify"
SSH_WRAPPER="${BIN}/git-ssh-yubikey-notify"
FOCUS_HELPER="${BIN}/orca-focus-terminal"
BANNER_HELPER="${BIN}/orca-alert-banner"
# Standard app location: macOS grants notification permission reliably there
NOTIFIER_APP="${BIN}/Orca-Notifier.app"
if [ -d /Applications ] && [ -w /Applications ]; then
  NOTIFIER_APP="/Applications/Orca-Notifier.app"
fi

mkdir -p "$BIN" "$SOUNDS"
cp "$REPO_DIR/bin/git-gpg-yubikey-notify" "$GPG_WRAPPER"
cp "$REPO_DIR/bin/git-ssh-yubikey-notify" "$SSH_WRAPPER"
cp "$REPO_DIR/bin/orca-focus-terminal" "$FOCUS_HELPER"
cp "$REPO_DIR/bin/orca-alert-banner" "$BANNER_HELPER"
cp "$REPO_DIR/sounds/yubikey-alert-2-beep.wav" "$SOUNDS/yubikey-alert-2-beep.wav"
chmod 755 "$GPG_WRAPPER" "$SSH_WRAPPER" "$FOCUS_HELPER" "$BANNER_HELPER"

# Builds the Orca-branded notifier: terminal-notifier carrying Orca's icon
# and display name, so alert banners show Orca's identity.
build_orca_notifier() {
  local src="" icon icon_name candidate dest="$NOTIFIER_APP"
  for candidate in \
    /opt/homebrew/opt/terminal-notifier/terminal-notifier.app \
    /opt/homebrew/Cellar/terminal-notifier/*/terminal-notifier.app \
    /usr/local/Cellar/terminal-notifier/*/terminal-notifier.app; do
    [ -d "$candidate" ] && { src="$candidate"; break; }
  done
  if [ -z "$src" ]; then
    printf 'warn: terminal-notifier.app not found; Orca banners fall back to sender branding.\n' >&2
    return 0
  fi
  icon_name="$(defaults read /Applications/Orca.app/Contents/Info.plist CFBundleIconFile 2>/dev/null || true)"
  icon="/Applications/Orca.app/Contents/Resources/${icon_name:-icon.icns}"
  if [ ! -f "$icon" ]; then
    icon="$(find /Applications/Orca.app/Contents/Resources -maxdepth 1 -name '*.icns' 2>/dev/null | head -n 1 || true)"
  fi
  if [ -z "${icon:-}" ] || [ ! -f "$icon" ]; then
    printf 'warn: Orca icon not found; Orca banners fall back to sender branding.\n' >&2
    return 0
  fi
  rm -rf "$dest"
  cp -R "$src" "$dest"
  cp "$icon" "$dest/Contents/Resources/app.icns"
  plutil -replace CFBundleIdentifier -string "com.pi-harness.orca-notifier" "$dest/Contents/Info.plist"
  plutil -replace CFBundleName -string "Orca" "$dest/Contents/Info.plist"
  plutil -replace CFBundleDisplayName -string "Orca" "$dest/Contents/Info.plist"
  plutil -replace CFBundleIconFile -string "app.icns" "$dest/Contents/Info.plist"
  codesign --force --sign - "$dest" >/dev/null 2>&1 || true
}
build_orca_notifier

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
printf '  sound=%s\n' "$SOUNDS/yubikey-alert-2-beep.wav"
printf '  focus-helper=%s\n' "$FOCUS_HELPER"
printf '  banner-helper=%s\n' "$BANNER_HELPER"
if [ -d "${NOTIFIER_APP}" ]; then
  printf '  orca-notifier=%s\n' "${NOTIFIER_APP}"
fi
if ! command -v terminal-notifier >/dev/null 2>&1; then
  printf 'note: terminal-notifier is not installed — Orca alerts fall back to a plain banner.\n'
  printf '      Install it with: brew install terminal-notifier\n'
fi
