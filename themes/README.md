# Themes

Custom theme files for pi. Each JSON file defines a palette via `vars` and assigns colors to UI roles via `colors`, following the theme schema referenced by each file's `$schema` field.

## Installation

`./install.sh` copies everything in this directory to `~/.pi/agent/themes/` (`rsync -a`, `.DS_Store` excluded, directory created if missing). The copy uses no `--delete`, so themes you add there yourself survive re-installs.

## Themes

| Theme | Description | Notable colors |
|---|---|---|
| `onedark-obsidian` | Dark blue-tinted palette on a near-black background. All message and tool panel backgrounds share one card color for a flat look, and the divider between turns is disabled. | accent `#789bbd` (muted steel blue), highlight `#b58bd8` (lavender), text `#c8d0dc` on bg `#05060a` |
| `quiet-night` | Warm, low-contrast dark theme with charcoal backgrounds and earthy role colors. Success/diff-added is sage green, error/diff-removed terracotta, warning ochre. | accent `#b69c6c` (muted gold), text `#c8c1b7` on bg `#191817` |
| `low-lumen` | The darkest of the three: near-black blue-gray background with cool, muted role colors — blue-gray, teal, sage, terracotta. | accent `#b9a978` (soft brass), text `#c9c6bd` on bg `#080b10` |

## Selecting a theme

Open `/settings` in pi and select **Theme** — the choice is saved as the `theme` setting in `~/.pi/agent/settings.json`. To try one for a single session without changing the saved setting:

```bash
pi --use-theme quiet-night
```

Pi hot-reloads the active theme from `~/.pi/agent/themes/<name>.json`, so edits to installed theme files show up live.
