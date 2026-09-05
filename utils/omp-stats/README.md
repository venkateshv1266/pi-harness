# Stats dashboard runtime

This directory is the local dependency root for the `/stats` pi extension. It
installs the published `@oh-my-pi/omp-stats` dashboard and keeps its lockfile
separate from the setup repository's root tooling.

## Install

Run this once after installing or updating the pi setup:

```bash
cd ~/.pi/agent/utils/omp-stats
bun install
```

The `/stats` extension starts the dashboard from the installed package and
opens it in the system browser. It uses port `3847` by default; pass another
port to `/stats` when needed, such as `/stats 4000`.
