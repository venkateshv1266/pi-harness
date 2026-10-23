# Security policy

## Supported versions

Only the latest `main` is supported. There are no long-lived release branches.

## Reporting a vulnerability

Email **venkateshv1266@gmail.com** with:

- a description of the issue and its impact,
- reproduction steps,
- the affected file or extension.

Do not open a public issue. You should get an acknowledgement within a few days. This is a personal
project with no bug bounty; credit will be given in the release notes if you want it.

## Scope

The harness runs inside your pi agent with your credentials. The highest-risk areas are:

- `extensions/jev-guard` (command and tool-result screening),
- `extensions/mcp-cookie-gate` (credential and cookie handling),
- `extensions/observatory` (reads local session logs and serves a dashboard),
- `install.sh` / `update.sh` (write to `~/.pi/agent` and run package installs).

Treat the installer as code you run with your user privileges: read it before running it.
