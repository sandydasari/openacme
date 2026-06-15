# Example mcp.json

The global MCP catalog at `<dataDir>/mcp.json`. Same JSON shape Claude
Desktop, Cursor, and Cline use — users can paste configs from
anywhere.

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  "github": {
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": {
      "Authorization": "Bearer ${GITHUB_TOKEN}"
    }
  },
  "postgres": {
    "command": "uvx",
    "args": ["mcp-server-postgres", "postgresql://localhost/mydb"],
    "env": {
      "PGPASSWORD": "secret123"
    }
  },
  "context7": {
    "url": "https://mcp.context7.com/mcp",
    "transport": "http",
    "enabled": true
  }
}
```

## Per-server fields

- **`command`** + **`args`** — stdio transport. Most common.
- **`url`** + **`transport`** — HTTP / SSE transport. `transport` is
  `"http"` or `"sse"`; omit to auto-detect (tries Streamable HTTP
  first, falls back to SSE on 404/405).
- **`env`** — environment variables forwarded to the subprocess. The
  inherited environment is filtered to drop credential-shaped vars
  (`AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, etc.) before spawning, so
  anything a server actually needs must be declared here.
- **`headers`** — HTTP headers for URL transports (auth tokens, etc.).
- **`timeout`** — tool-call timeout in seconds (default 120).
- **`connectTimeout`** — connection timeout in seconds (default 60).
- **`enabled`** — set to `false` to keep the entry but skip
  connecting.
- **`allowedTools`** — if set, only register tools whose names match
  this list. Empty/absent = all tools.

## Applies live

The platform watches `mcp.json`. After editing, the affected agents
re-discover servers and their tools on their next turn — no restart.
(Bringing a slow or broken server up can take a few seconds.)

## Per-agent overrides

- **`mcpServers`** in AGENT.md — agent-private MCP servers (cannot
  share names with the global `mcp.json` catalog).
- **`mcpDisabled`** in AGENT.md — list of global server names to
  exclude from this specific agent.

## OAuth

For servers that require OAuth (Streamable HTTP / SSE only), the
platform handles the browser flow automatically. Boot does not block
on OAuth — unauthorized servers land in `awaiting_oauth` and the user
explicitly authorizes via the web UI's MCP page or the
`openacme mcp` CLI.
