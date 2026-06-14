# Security Policy

OpenAcme is a local-first daemon that handles model-provider credentials and OAuth tokens, drives a browser logged into your accounts, and executes tools (shell, file IO, code) on your machine. We take security reports seriously.

## Supported versions

Security fixes target the latest published `@openacme/*` release on npm. Please upgrade to the latest version before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's [private vulnerability reporting](https://github.com/sandydasari/openacme/security/advisories/new), or email **sandydasari977@gmail.com** with:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept if possible).
- Affected version(s) and platform.

We aim to acknowledge a report within 72 hours and to keep you updated as we investigate. Once a fix is released, we're happy to credit you in the advisory unless you'd prefer to remain anonymous.

## Scope

Things we especially want to hear about:

- Leakage of credentials or OAuth tokens (`auth.json`, model API keys) into logs, network requests, error messages, or the web/SSE channel.
- Path traversal or arbitrary file write outside the data dir (`~/.openacme/`) — e.g. via skills hub install, attachments, or agent resources.
- Sandbox/privilege issues in tool execution (`shell`, `execute_code`, `apply_patch`) or MCP server handling.
- The web ↔ server channel: today there is **no auth on the local web channel** (it assumes a trusted local environment), so reports that depend on a non-loopback bind without the access secret are expected — but anything that bypasses the access secret on an exposed (`--expose`) daemon is in scope.
- MCP env-var leakage past `buildSafeEnv` filtering.

## Handling secrets in reports

Never paste raw tokens or `auth.json` contents into a report. Redact credentials in any logs you share.
