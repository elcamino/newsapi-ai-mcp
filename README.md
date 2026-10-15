# newsapi-ai-mcp

MCP server for [newsapi.ai](https://newsapi.ai) (Event Registry): search news articles and events from ~150k sources
worldwide — from Claude (Code, Desktop, claude.ai), Codex, OpenCode, Cursor or any other MCP client.
Ships with an [Agent Skill](skill/newsapi-ai/SKILL.md) that teaches agents how to query the API well
(and how to fall back to plain `curl` where no MCP is available).

## Tools

| Tool | What it does |
|---|---|
| `newsapi_search_articles` | Article search: keywords, concepts, categories, sources, locations, language, dates, sentiment, source rank; Advanced Query Language passthrough |
| `newsapi_get_articles` | Full text + metadata by article URI or original URL |
| `newsapi_search_events` | Event search (articles clustered by real-world happening, cross-language) |
| `newsapi_get_event` | Event details + top articles |
| `newsapi_suggest` | Resolve names → URIs (concepts, sources, source groups, categories, locations, authors) |
| `newsapi_usage` | Remaining API tokens |
| `newsapi_raw_request` | Escape hatch: any `/api/v1/…` endpoint (aggregations, trends, minute stream) |

Results are trimmed to compact JSON (snippets instead of full bodies, flattened labels) to save context; pass
`response_format: "raw"` for the untouched API response.

## Configuration

| Variable | |
|---|---|
| `NEWSAPI_AI_KEY` | your newsapi.ai API key (required) |
| `NEWSAPI_AI_MAX_DAYS` | `7` or `31`: hard cap, never query older data (archive queries cost more tokens) |
| `NEWSAPI_AI_HOST` | API host, default `https://eventregistry.org` |
| `MCP_AUTH_TOKEN` | HTTP mode only: bearer token clients must send |

## Install — local (stdio)

Until the package is on npm, replace `npx -y newsapi-ai-mcp` with
`npx -y github:<owner>/newsapi-ai-mcp` or `node /path/to/newsapi-ai-mcp/dist/index.js`
(after `npm install` in the checkout).

**Claude Code**
```bash
claude mcp add newsapi-ai -s user -e NEWSAPI_AI_KEY=your-key -- npx -y newsapi-ai-mcp
```

**Claude Desktop** — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "newsapi-ai": {
      "command": "npx",
      "args": ["-y", "newsapi-ai-mcp"],
      "env": { "NEWSAPI_AI_KEY": "your-key" }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`
```toml
[mcp_servers.newsapi-ai]
command = "npx"
args = ["-y", "newsapi-ai-mcp"]
env = { NEWSAPI_AI_KEY = "your-key" }
```

**OpenCode** — `opencode.json` (project) or `~/.config/opencode/opencode.json`
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "newsapi-ai": {
      "type": "local",
      "command": ["npx", "-y", "newsapi-ai-mcp"],
      "environment": { "NEWSAPI_AI_KEY": "{env:NEWSAPI_AI_KEY}" },
      "enabled": true
    }
  }
}
```

**Cursor / Windsurf / Cline / Zed / anything else**: same `command` + `args` + `env` triple in that client's MCP config.

## Install — remote (Streamable HTTP)

For claude.ai custom connectors, Claude mobile, or sharing one server across machines:

```bash
NEWSAPI_AI_KEY=your-key MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  npx -y newsapi-ai-mcp --http --host 0.0.0.0 --port 8787
```

- Endpoint: `https://your-host/mcp` (health check: `/health`). Stateless, POST only.
- Auth: `Authorization: Bearer <MCP_AUTH_TOKEN>`; clients that can't set headers (e.g. a claude.ai custom
  connector) can use `https://your-host/mcp?token=<MCP_AUTH_TOKEN>`.
- Optional per-client API key: header `X-NewsAPI-Key` overrides `NEWSAPI_AI_KEY`.
- Run it behind TLS (Caddy, Traefik, Cloudflare Tunnel).

Docker + Caddy:

```bash
docker compose up -d   # see docker-compose.yml, put NEWSAPI_AI_KEY / MCP_AUTH_TOKEN in .env
```
```caddyfile
news-mcp.example.com {
  reverse_proxy newsapi-ai-mcp:8787
}
```

Then in claude.ai: *Settings → Connectors → Add custom connector* → URL `https://news-mcp.example.com/mcp?token=…`.

Remote config for other clients, e.g. Claude Code:
```bash
claude mcp add --transport http newsapi-ai https://news-mcp.example.com/mcp --header "Authorization: Bearer …"
```

## The skill

`skill/newsapi-ai/` is a standard `SKILL.md` folder:

- **Claude Code:** copy to `~/.claude/skills/newsapi-ai/` (or `.claude/skills/` in a repo)
- **claude.ai / Desktop:** zip the folder and upload it under *Settings → Capabilities → Skills*
- **Codex / OpenCode / others with Agent Skills support:** put it in the client's skills directory;
  otherwise paste it into `AGENTS.md` or the system prompt

## Development

```bash
npm install
npm test        # builds, then runs an end-to-end test (stdio + HTTP) against a mock API
```

MIT License.
