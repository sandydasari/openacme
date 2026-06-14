---
"@openacme/tool-host": patch
---

`discoverMcp` now retries when the worker exits mid-call (a documented retryable condition), so a transient worker blip during agent creation no longer drops the agent's MCP tools or fails the call.
