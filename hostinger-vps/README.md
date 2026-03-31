# Hostinger VPS — MCP Server

**Version:** 1.0.0

MCP server for managing Hostinger VPS instances and executing shell commands via SSH. Built for trading bot VPS management.

## Tools

### SSH Terminal

| Tool | Description |
|------|-------------|
| `vps_terminal` | Execute shell commands on VPS via SSH (key from env var) |

### VPS Management (Hostinger API)

All API tools require a Hostinger API token ([get one here](https://developers.hostinger.com)).

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

## Quick Start

```bash
cd hostinger-vps
npm install

# Set your SSH key for vps_terminal
export HOSTINGER_SSH_KEY_FILE=~/.ssh/your_hostinger_key

npm start            # HTTP server on port 3001
npm run start:stdio  # stdio mode (Claude Desktop)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `HOSTINGER_SSH_KEY` | — | SSH private key contents for `vps_terminal` |
| `HOSTINGER_SSH_KEY_FILE` | — | Path to SSH private key file (alternative) |

## Claude Desktop Config

```json
{
  "mcpServers": {
    "hostinger-vps": {
      "command": "node",
      "args": ["/path/to/hostinger-vps/server.mjs", "--stdio"],
      "env": {
        "HOSTINGER_SSH_KEY_FILE": "/path/to/.ssh/your_hostinger_key"
      }
    }
  }
}
```
