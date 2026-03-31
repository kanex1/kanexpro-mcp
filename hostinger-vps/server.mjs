#!/usr/bin/env node

/**
 * Hostinger VPS — MCP Server v1.0.0
 *
 * MCP server for managing Hostinger VPS instances and executing
 * shell commands via SSH. Built for trading bot VPS management.
 *
 * Tools:
 *   vps_terminal        — Execute shell commands on VPS via SSH
 *   vps_list            — List all VPS instances
 *   vps_info            — Get details of a specific VM
 *   vps_start           — Start a VM
 *   vps_stop            — Stop a VM
 *   vps_restart         — Restart a VM
 *   vps_set_hostname    — Set hostname for a VM
 *   vps_set_root_password — Set root password
 *   vps_actions         — List actions performed on a VM
 *   vps_metrics         — Get CPU/RAM/disk/network metrics
 *   vps_firewall_list   — List firewalls
 *   vps_firewall_rules  — Get firewall details and rules
 *   vps_firewall_activate — Activate a firewall on a VM
 *   vps_backups         — List backups for a VM
 *   vps_create_snapshot — Create a snapshot
 *   vps_restore_backup  — Restore a VM from backup
 *   vps_post_install_scripts — List post-install scripts
 *   vps_create_post_install  — Create a post-install script
 *   vps_ssh_keys        — List SSH public keys
 *   vps_attach_ssh_key  — Attach SSH key to a VM
 *   vps_os_templates    — List available OS templates
 *   vps_data_centers    — List available data centers
 *   vps_recreate        — Reinstall OS on a VM (destructive)
 *
 * Environment variables:
 *   HOSTINGER_SSH_KEY      — SSH private key contents (for vps_terminal)
 *   HOSTINGER_SSH_KEY_FILE — Path to SSH private key file (alternative)
 *   PORT                   — HTTP server port (default: 3001)
 *
 * Usage:
 *   node server.mjs              → HTTP on port 3001 (or $PORT)
 *   node server.mjs --stdio      → stdio transport (Claude Desktop)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { fetch as uFetch, Agent } from 'undici';
import { Client as SSHClient } from 'ssh2';
import { readFileSync } from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────

const HOSTINGER_API = 'https://developers.hostinger.com/api';
const PORT = parseInt(process.env.PORT || '3001', 10);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 4000;
const USE_STDIO = process.argv.includes('--stdio');

const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await uFetch(url, { ...options, dispatcher });
      if (res.status === 503 && attempt < retries) { await sleep(RETRY_DELAY_MS); continue; }
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, body };
    } catch (err) {
      if (attempt < retries) { await sleep(RETRY_DELAY_MS); continue; }
      throw err;
    }
  }
}

async function hostingerFetch(path, token, options = {}) {
  const url = `${HOSTINGER_API}${path}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers };
  return fetchRetry(url, { ...options, headers });
}

function resolveSSHKey() {
  if (process.env.HOSTINGER_SSH_KEY) return process.env.HOSTINGER_SSH_KEY;
  if (process.env.HOSTINGER_SSH_KEY_FILE) {
    return readFileSync(process.env.HOSTINGER_SSH_KEY_FILE, 'utf-8');
  }
  return null;
}

// ── Server Factory ──────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'hostinger-vps', version: '1.0.0' });

  // ── vps_terminal ──────────────────────────────────────────────────────

  server.tool(
    'vps_terminal',
    'Execute a shell command on your Hostinger VPS via SSH. Returns stdout and stderr. SSH key is read from env var HOSTINGER_SSH_KEY or HOSTINGER_SSH_KEY_FILE. Commands run as root by default. ⚠️ Ask user for confirmation before running destructive commands.',
    {
      host: z.string().describe('VPS IP address or hostname'),
      command: z.string().describe('Shell command to execute on the VPS'),
      username: z.string().optional().describe('SSH username (default: root)'),
      port: z.number().optional().describe('SSH port (default: 22)'),
      timeout: z.number().optional().describe('Command timeout in seconds (default: 30)'),
    },
    async ({ host, command, username, port, timeout }) => {
      let privateKey;
      try {
        privateKey = resolveSSHKey();
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Cannot read SSH key file: ${err.message}` }] };
      }
      if (!privateKey) {
        return { content: [{ type: 'text', text: '❌ No SSH key found. Set HOSTINGER_SSH_KEY (key contents) or HOSTINGER_SSH_KEY_FILE (path to key file) as an environment variable.' }] };
      }

      const sshUser = username || 'root';
      const sshPort = port || 22;
      const cmdTimeout = (timeout || 30) * 1000;

      return new Promise((resolve) => {
        const conn = new SSHClient();
        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            conn.end();
            resolve({ content: [{ type: 'text', text: `❌ Command timed out after ${cmdTimeout / 1000}s.\n\nPartial stdout:\n${stdout}\n\nPartial stderr:\n${stderr}` }] });
          }
        }, cmdTimeout);

        conn.on('ready', () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              finished = true;
              conn.end();
              resolve({ content: [{ type: 'text', text: `❌ SSH exec error: ${err.message}` }] });
              return;
            }
            stream.on('data', (data) => { stdout += data.toString(); });
            stream.stderr.on('data', (data) => { stderr += data.toString(); });
            stream.on('close', (code) => {
              if (finished) return;
              clearTimeout(timer);
              finished = true;
              conn.end();
              let result = '';
              if (stdout.trim()) result += stdout.trim();
              if (stderr.trim()) result += (result ? '\n\n--- stderr ---\n' : '') + stderr.trim();
              if (!result) result = `(no output — exit code ${code})`;
              result = `Exit code: ${code}\n\n${result}`;
              resolve({ content: [{ type: 'text', text: result }] });
            });
          });
        });

        conn.on('error', (err) => {
          if (finished) return;
          clearTimeout(timer);
          finished = true;
          resolve({ content: [{ type: 'text', text: `❌ SSH connection error: ${err.message}` }] });
        });

        conn.connect({
          host,
          port: sshPort,
          username: sshUser,
          privateKey,
        });
      });
    }
  );

  // ── vps_list ──────────────────────────────────────────────────────────

  server.tool(
    'vps_list',
    'List all Hostinger VPS instances. Returns VM IDs, hostnames, IPs, status, OS, and plan details. Requires Hostinger API token.',
    {
      token: z.string().describe('Hostinger API token (Bearer) — ask user to provide it'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/virtual-machines', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized — invalid or expired Hostinger API token.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_info ──────────────────────────────────────────────────────────

  server.tool(
    'vps_info',
    'Get detailed information about a specific Hostinger VPS. Returns hostname, IP, OS, plan, status, resources, and more.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID (from vps_list)'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}`, token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status === 404) return { content: [{ type: 'text', text: `❌ 404 — VM ${vm_id} not found.` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_start ─────────────────────────────────────────────────────────

  server.tool(
    'vps_start',
    'Start a Hostinger VPS. ⚠️ Ask user for confirmation before calling.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/start`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ VM ${vm_id} start initiated — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_stop ──────────────────────────────────────────────────────────

  server.tool(
    'vps_stop',
    'Stop a Hostinger VPS. ⚠️ Ask user for confirmation before calling.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/stop`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ VM ${vm_id} stop initiated — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_restart ───────────────────────────────────────────────────────

  server.tool(
    'vps_restart',
    'Restart a Hostinger VPS. ⚠️ Ask user for confirmation before calling.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/restart`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ VM ${vm_id} restart initiated — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_set_hostname ──────────────────────────────────────────────────

  server.tool(
    'vps_set_hostname',
    'Set hostname for a Hostinger VPS.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      hostname: z.string().describe('New hostname for the VM'),
    },
    async ({ token, vm_id, hostname }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/hostname`, token, { method: 'PUT', body: JSON.stringify({ hostname }) });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Hostname set to "${hostname}" — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_set_root_password ─────────────────────────────────────────────

  server.tool(
    'vps_set_root_password',
    'Set root password for a Hostinger VPS. ⚠️ Ask user for confirmation before calling.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      password: z.string().describe('New root password'),
    },
    async ({ token, vm_id, password }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/root-password`, token, { method: 'PUT', body: JSON.stringify({ password }) });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Root password updated — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_actions ───────────────────────────────────────────────────────

  server.tool(
    'vps_actions',
    'List actions (operations/events) performed on a Hostinger VPS — start, stop, restart, etc.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/actions`, token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_metrics ───────────────────────────────────────────────────────

  server.tool(
    'vps_metrics',
    'Get historical performance metrics (CPU, RAM, disk, network) for a Hostinger VPS.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      date_from: z.string().describe('Start date (ISO 8601, e.g. "2025-03-01T00:00:00Z")'),
      date_to: z.string().describe('End date (ISO 8601, e.g. "2025-03-31T23:59:59Z")'),
    },
    async ({ token, vm_id, date_from, date_to }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/metrics?date_from=${encodeURIComponent(date_from)}&date_to=${encodeURIComponent(date_to)}`, token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_firewall_list ─────────────────────────────────────────────────

  server.tool(
    'vps_firewall_list',
    'List all Hostinger VPS firewalls.',
    {
      token: z.string().describe('Hostinger API token'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/firewalls', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_firewall_rules ────────────────────────────────────────────────

  server.tool(
    'vps_firewall_rules',
    'Get a specific Hostinger firewall and its rules by ID.',
    {
      token: z.string().describe('Hostinger API token'),
      firewall_id: z.number().describe('Firewall ID (from vps_firewall_list)'),
    },
    async ({ token, firewall_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/firewalls/${firewall_id}`, token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status === 404) return { content: [{ type: 'text', text: `❌ 404 — Firewall ${firewall_id} not found.` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_firewall_activate ─────────────────────────────────────────────

  server.tool(
    'vps_firewall_activate',
    'Activate a firewall on a Hostinger VPS. Only one firewall can be active per VM. ⚠️ Ask user for confirmation.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      firewall_id: z.number().describe('Firewall ID to activate'),
    },
    async ({ token, vm_id, firewall_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/firewalls/${firewall_id}/activate/${vm_id}`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Firewall ${firewall_id} activated on VM ${vm_id} — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_backups ───────────────────────────────────────────────────────

  server.tool(
    'vps_backups',
    'List backups for a Hostinger VPS.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/backups`, token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_create_snapshot ───────────────────────────────────────────────

  server.tool(
    'vps_create_snapshot',
    'Create a snapshot of a Hostinger VPS. ⚠️ Ask user for confirmation.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
    },
    async ({ token, vm_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/snapshot`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Snapshot created for VM ${vm_id} — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_restore_backup ────────────────────────────────────────────────

  server.tool(
    'vps_restore_backup',
    'Restore a Hostinger VPS from a backup. ⚠️ DESTRUCTIVE — ask user for confirmation.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      backup_id: z.number().describe('Backup ID (from vps_backups)'),
    },
    async ({ token, vm_id, backup_id }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/backups/${backup_id}/restore`, token, { method: 'POST' });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Restore initiated for VM ${vm_id} from backup ${backup_id} — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_post_install_scripts ──────────────────────────────────────────

  server.tool(
    'vps_post_install_scripts',
    'List all post-install scripts in your Hostinger account. These are shell scripts that run after VPS setup.',
    {
      token: z.string().describe('Hostinger API token'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/post-install-scripts', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_create_post_install ───────────────────────────────────────────

  server.tool(
    'vps_create_post_install',
    'Create a new post-install script. Saved as /post_install on the VPS and executed with root privileges after OS install. Output goes to /post_install.log. Max 48KB. ⚠️ Ask user for confirmation.',
    {
      token: z.string().describe('Hostinger API token'),
      name: z.string().describe('Script name (for identification)'),
      content: z.string().describe('Shell script content (include #!/bin/bash shebang)'),
    },
    async ({ token, name, content }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/post-install-scripts', token, { method: 'POST', body: JSON.stringify({ name, content }) });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 201) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Post-install script "${name}" created — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_ssh_keys ──────────────────────────────────────────────────────

  server.tool(
    'vps_ssh_keys',
    'List all SSH public keys in your Hostinger account.',
    {
      token: z.string().describe('Hostinger API token'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/public-keys', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_attach_ssh_key ────────────────────────────────────────────────

  server.tool(
    'vps_attach_ssh_key',
    'Attach an SSH public key to a Hostinger VPS for key-based authentication.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      key_ids: z.array(z.number()).describe('Array of public key IDs to attach (from vps_ssh_keys)'),
    },
    async ({ token, vm_id, key_ids }) => {
      try {
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/public-keys`, token, { method: 'POST', body: JSON.stringify({ ids: key_ids }) });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ SSH keys attached to VM ${vm_id} — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_os_templates ──────────────────────────────────────────────────

  server.tool(
    'vps_os_templates',
    'List available OS templates for Hostinger VPS (Ubuntu, Debian, CentOS, etc.).',
    {
      token: z.string().describe('Hostinger API token'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/templates', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_data_centers ──────────────────────────────────────────────────

  server.tool(
    'vps_data_centers',
    'List available Hostinger data centers for VPS deployment.',
    {
      token: z.string().describe('Hostinger API token'),
    },
    async ({ token }) => {
      try {
        const { status, body } = await hostingerFetch('/vps/v1/data-centers', token);
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_recreate ──────────────────────────────────────────────────────

  server.tool(
    'vps_recreate',
    'Recreate (reinstall OS) a Hostinger VPS. ⚠️ DESTRUCTIVE — all data will be lost. Ask user for confirmation.',
    {
      token: z.string().describe('Hostinger API token'),
      vm_id: z.number().describe('Virtual machine ID'),
      template_id: z.number().describe('OS template ID (from vps_os_templates)'),
      password: z.string().describe('New root password'),
      post_install_script_id: z.number().optional().describe('Optional post-install script ID to run after setup'),
    },
    async ({ token, vm_id, template_id, password, post_install_script_id }) => {
      try {
        const payload = { template_id, password };
        if (post_install_script_id) payload.post_install_script_id = post_install_script_id;
        const { status, body } = await hostingerFetch(`/vps/v1/virtual-machines/${vm_id}/recreate`, token, { method: 'POST', body: JSON.stringify(payload) });
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized.' }] };
        if (status !== 200 && status !== 202) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ VM ${vm_id} recreate initiated — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  return server;
}

// ── Transport: HTTP (Streamable HTTP) ───────────────────────────────────────

async function startHTTP() {
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    if (_req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Bearer token auth — blocks all requests without valid token
  if (MCP_AUTH_TOKEN) {
    app.use((req, res, next) => {
      // Allow health check without auth
      if (req.path === '/health') return next();
      const auth = req.headers['authorization'];
      if (!auth || auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
        return res.status(401).json({ error: 'Unauthorized — invalid or missing Bearer token' });
      }
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'hostinger-vps', version: '1.0.0' });
  });

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.status(404).json({ error: 'OAuth not supported' });
  });
  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.status(404).json({ error: 'OAuth not supported' });
  });

  const headHandler = (_req, res) => {
    res.setHeader('MCP-Protocol-Version', '2024-11-05');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end();
  };
  app.head('/', headHandler);
  app.head('/mcp', headHandler);

  const mcpPostHandler = async (req, res) => {
    const server = createServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => { transport.close(); server.close(); });
    } catch (error) {
      console.error('MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };
  app.post('/', mcpPostHandler);
  app.post('/mcp', mcpPostHandler);

  const methodNotAllowed = (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
  app.delete('/', methodNotAllowed);

  app.get('/', (_req, res) => {
    res.json({ server: 'hostinger-vps', version: '1.0.0', mcp: '/mcp', health: '/health' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, '0.0.0.0', (err) => {
    if (err) { console.error('Failed to start:', err); process.exit(1); }
    console.log(`Hostinger VPS MCP Server v1.0.0 — HTTP on port ${PORT}`);
    console.log(`  MCP endpoint: http://0.0.0.0:${PORT}/mcp (or /)`);
    console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
  });
}

// ── Transport: stdio ────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Hostinger VPS MCP Server v1.0.0 — stdio');
}

// ── Main ────────────────────────────────────────────────────────────────────

if (USE_STDIO) {
  startStdio().catch(err => { console.error('Fatal:', err); process.exit(1); });
} else {
  startHTTP().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

process.on('SIGINT', () => { console.log('Shutting down...'); process.exit(0); });
