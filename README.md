# KanexPro Product API + Hostinger VPS — MCP Server

**Version:** 1.3.0

Remote MCP server exposing the KanexPro CMS API and Hostinger VPS management as tools for Claude.

## KanexPro Tools

| Tool | Endpoint | Key | Description |
|------|----------|-----|-------------|
| `lookup` | GET /cmslookup | No | Primary product lookup — flat JSON |
| `list` | GET /list | Optional | List products by category/subcategory. MSRP/stock hidden without key |
| `push` | POST /push | **Yes** | Push file/metadata to staging |
| `publish` | POST /publish | **Yes** | Publish file/metadata to production |

> `push` and `publish` require the user to provide their key and confirm each time.
>
> `list` returns product data without a key, but strips MSRP and stock. Provide the key to see pricing.

## Hostinger VPS Tools

All VPS tools require a Hostinger API token ([get one here](https://developers.hostinger.com)).

| Tool | Method | Description |
|------|--------|-------------|
| `vps_list` | GET | List all VPS instances |
| `vps_info` | GET | Get details of a specific VM |
| `vps_start` | POST | Start a VM |
| `vps_stop` | POST | Stop a VM |
| `vps_restart` | POST | Restart a VM |
| `vps_set_hostname` | PUT | Set hostname for a VM |
| `vps_set_root_password` | PUT | Set root password for a VM |
| `vps_actions` | GET | List actions performed on a VM |
| `vps_metrics` | GET | Get historical CPU/RAM/disk/network metrics |
| `vps_firewall_list` | GET | List all firewalls |
| `vps_firewall_rules` | GET | Get firewall details and rules |
| `vps_firewall_activate` | POST | Activate a firewall on a VM |
| `vps_backups` | GET | List backups for a VM |
| `vps_create_snapshot` | POST | Create a snapshot |
| `vps_restore_backup` | POST | Restore a VM from backup |
| `vps_post_install_scripts` | GET | List post-install scripts |
| `vps_create_post_install` | POST | Create a shell script to run after OS install |
| `vps_ssh_keys` | GET | List SSH public keys |
| `vps_attach_ssh_key` | POST | Attach SSH key to a VM |
| `vps_os_templates` | GET | List available OS templates |
| `vps_data_centers` | GET | List available data centers |
| `vps_recreate` | POST | Reinstall OS on a VM (destructive) |
| `vps_terminal` | SSH | Execute shell commands on VPS via SSH |

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
