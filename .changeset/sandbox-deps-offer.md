---
"@openacme/cli": minor
---

`openacme start` now detects missing sandbox dependencies (bubblewrap, socat, ripgrep) and offers to install them with your package manager (apt/dnf/pacman/zypper/apk, or brew on macOS) — so a fresh Linux box runs agent tools sandboxed instead of unconfined, without hunting for the right command. Non-interactive shells just print the exact command. Self-hosting + troubleshooting docs document the prerequisites.
