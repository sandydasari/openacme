---
"@openacme/server": minor
---

Unify MCP server management on a single JSON editor across the per-agent tab, global Settings, and the new-agent wizard — matching the raw-config UX of Claude Desktop / Cursor / Cline, replacing the bespoke form. Per-agent MCP status now aggregates stdio servers (previously invisible), per-server connect/disconnect/reconnect are transport-aware (no more 404 on stdio), and a new batch `PUT /api/agents/:id/mcp` saves validated config. Also fixes home-page agent-filter persistence.
