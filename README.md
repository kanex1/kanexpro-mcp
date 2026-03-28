# KanexPro Product API — MCP Server

**Version:** 1.2.0

Remote MCP server exposing the KanexPro CMS API as tools for Claude.

## Tools

| Tool | Endpoint | Key | Description |
|------|----------|-----|-------------|
| `cmslookup` | GET /cmslookup | No | Primary product lookup — flat JSON |
| `list` | GET /list | Optional | List products by category/subcategory. MSRP/stock hidden without key |
| `push` | POST /push | **Yes** | Push file/metadata to staging ⚠️ |
| `publish` | POST /publish | **Yes** | Publish file/metadata to production ⚠️ |

> ⚠️ `push` and `publish` require the user to provide their key and confirm each time.
>
> `list` returns product data without a key, but strips MSRP and stock. Provide the key to see pricing.

## Quick Start

```bash
npm install
npm start            # HTTP server on port 3000
npm run start:stdio  # stdio mode (Claude Desktop)
```

## Transports

### HTTP (Remote — for Claude.ai)

```bash
node server.mjs
# → MCP endpoint: http://0.0.0.0:3000/mcp
# → Health check: http://0.0.0.0:3000/health
```

### stdio (Local — for Claude Desktop)

```bash
node server.mjs --stdio
```

## Connect to Claude.ai (Remote MCP)

Once hosted at a public HTTPS URL:

**URL:** `https://your-domain.com/mcp`

## Claude Desktop Config

```json
{
  "mcpServers": {
    "kanexpro-api": {
      "command": "node",
      "args": ["/path/to/kanexpro-mcp/server.mjs", "--stdio"]
    }
  }
}
```

## Hosting

### Railway (recommended)

1. Push to GitHub
2. Connect repo in [railway.app](https://railway.app)
3. Auto-runs `npm start` — Railway provides `PORT`
4. Use the Railway HTTPS URL as your MCP endpoint

### Any Node.js Host

```bash
PORT=8080 node server.mjs
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `KANEXPRO_API_URL` | `https://api.kanexpro.com` | API base URL |
| `HTTPS_PROXY` | *(auto)* | Egress proxy URL |

## Test

```bash
node test.mjs    # 16 automated tests against live API
```
