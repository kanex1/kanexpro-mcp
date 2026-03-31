#!/usr/bin/env node

/**
 * KanexPro Product API + Hostinger VPS — MCP Server v1.3.0
 *
 * Remote MCP server exposing the KanexPro CMS API and Hostinger VPS management.
 * Runs as Streamable HTTP (for Claude.ai / remote) or stdio (for Claude Desktop).
 *
 * KanexPro Tools:
 *   lookup      — Look up a product by SKU (primary lookup — no key needed)
 *   list        — List products by category / subcategory (key required for stock)
 *   push        — Push file or metadata to staging  (⚠️ key required, ask user first)
 *   publish     — Publish file or metadata to prod   (⚠️ key required, ask user first)
 *
 * Hostinger VPS Tools:
 *   vps_list            — List all VPS instances
 *   vps_info            — Get details of a specific VM
 *   vps_start           — Start a VM
 *   vps_stop            — Stop a VM
 *   vps_restart         — Restart a VM
 *   vps_firewall_list   — List firewalls
 *   vps_firewall_rules  — Get firewall details and rules
 *   vps_backups         — List backups for a VM
 *   vps_create_snapshot — Create a snapshot
 *   vps_restore_backup  — Restore a VM from backup
 *   vps_actions         — List actions performed on a VM
 *   vps_post_install_scripts — List post-install scripts
 *   vps_create_post_install  — Create a post-install script
 *   vps_ssh_keys        — List SSH public keys
 *   vps_terminal        — Execute shell commands on VPS via SSH
 *
 * Usage:
 *   node server.mjs              → HTTP on port 3000 (or $PORT)
 *   node server.mjs --stdio      → stdio transport (Claude Desktop)
 *
 * API key is NOT hardcoded — user must provide key for push, publish, and list (to see MSRP).
 * Hostinger API token must be provided by user for all vps_ tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { ProxyAgent, fetch as uFetch, Agent } from 'undici';
import { Client as SSHClient } from 'ssh2';

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.KANEXPRO_API_URL || 'https://api.kanexpro.com';
const HOSTINGER_API = 'https://developers.hostinger.com/api';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 4000;
const USE_STDIO = process.argv.includes('--stdio');

// Proxy-aware dispatcher with TLS disabled (cert issue on api.kanexpro.com)
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = PROXY_URL
  ? new ProxyAgent({ uri: PROXY_URL, connect: { rejectUnauthorized: false } })
  : new Agent({ connect: { rejectUnauthorized: false } });

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

function buildFormData(fields, fileField) {
  const boundary = `----KanexProMCP${Date.now()}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  if (fileField) {
    const { fieldName, filename, contentType, buffer } = fileField;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
    const textPart = Buffer.from(parts.join(''), 'utf-8');
    const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'base64');
    return { body: Buffer.concat([textPart, fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  return { body: Buffer.from(parts.join('') + `--${boundary}--\r\n`, 'utf-8'), contentType: `multipart/form-data; boundary=${boundary}` };
}

const isPng = (t) => ['diagram','panel','applications','banner','social_square','social_landscape'].includes(t);

// Hostinger API helper — Bearer token auth, JSON responses
async function hostingerFetch(path, token, options = {}) {
  const url = `${HOSTINGER_API}${path}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers };
  return fetchRetry(url, { ...options, headers });
}

const TYPES = ['sheet','manual','marketing','sales_sheet','diagram','panel','applications','banner','social_square','social_landscape','metadata'];

// ── Server Factory ──────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'kanexpro-api', version: '1.3.0' });

  // ── lookup ───────────────────────────────────────────────────────────

  server.tool(
    'lookup',
    'Look up a KanexPro product by SKU (PRIMARY lookup). No key needed. Returns FLAT JSON: title, subtitle, overview_html, features_html, specs_html, faq_json (parsed array), upc, category, subcategory, msrp, dealer (msrp × 0.6), status, photo_url, and file URLs.',
    {
      sku: z.string().describe('Product MPN / SKU (e.g. AVO-IPJP2K)'),
    },
    async ({ sku }) => {
      try {
        const url = `${BASE_URL}/api/Claude/cmslookup?sku=${encodeURIComponent(sku)}&key=9876`;
        const { status, body } = await fetchRetry(url);
        if (status === 401) return { content: [{ type: 'text', text: `❌ 401 Unauthorized — lookup auth error.` }] };
        if (status === 404) return { content: [{ type: 'text', text: `❌ 404 — SKU "${sku}" not found in CMS.` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        // API may return trailing commas — clean and re-parse if body is a string
        let data = body;
        if (typeof data === 'string') {
          try { data = JSON.parse(data.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch { /* keep as-is */ }
        }
        // Add dealer price = MSRP × 0.6
        if (data && typeof data === 'object' && typeof data.msrp === 'number') {
          data.dealer = Math.round(data.msrp * 0.6 * 100) / 100;
        }
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── list ────────────────────────────────────────────────────────────────

  server.tool(
    'list',
    'List KanexPro products by category/subcategory via /list. Returns {"products":[...]} with SKU, title, subtitle, MSRP, dealer (MSRP × 0.6), status, photo_url, file URLs. Note: Diagram uses capital D. Stock fields only included with valid key.',
    {
      category: z.string().describe('Top-level category (e.g. "AV Over IP")'),
      subcategory: z.string().describe('Subcategory (e.g. "JPEG2000")'),
      key: z.string().optional().describe('API key — required to see cost and stock data. MSRP is always visible.'),
    },
    async ({ category, subcategory, key }) => {
      try {
        const url = `${BASE_URL}/api/Claude/list?category=${encodeURIComponent(category)}&subcategory=${encodeURIComponent(subcategory)}`;
        const { status, body } = await fetchRetry(url);
        if (status === 400) return { content: [{ type: 'text', text: `❌ 400 — ${JSON.stringify(body)}` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        let products = body?.products || [];
        if (products.length === 0) {
          return { content: [{ type: 'text', text: `No products found for "${category}" / "${subcategory}".` }] };
        }
        // Strip cost/stock fields unless valid key is provided. MSRP stays visible.
        const authorized = key && key.trim() === '9876';
        if (!authorized) {
          products = products.map(p => {
            const { cost, stock, stockEU, ...rest } = p;
            return rest;
          });
        }
        // Add dealer price (MSRP × 0.6) to every product
        products = products.map(p => {
          if (typeof p.msrp === 'number') {
            p.dealer = Math.round(p.msrp * 0.6 * 100) / 100;
          }
          return p;
        });
        return { content: [{ type: 'text', text: JSON.stringify({ products }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── push ────────────────────────────────────────────────────────────────

  server.tool(
    'push',
    'Push file or metadata to KanexPro staging (POST /push). Multipart/form-data. ⚠️ ALWAYS ASK USER FOR CONFIRMATION AND KEY BEFORE CALLING.',
    {
      mpn: z.string().describe('Product MPN'),
      key: z.string().describe('API key — required, ask user each time'),
      type: z.enum(TYPES).describe('Push type'),
      title: z.string().optional(), subtitle: z.string().optional(),
      meta_description: z.string().optional(), meta_keywords: z.string().optional(),
      overview_html: z.string().optional(), features_html: z.string().optional(),
      specs_html: z.string().optional(), faq_json: z.string().optional(),
      file_base64: z.string().optional().describe('Base64-encoded file (PDF or PNG)'),
      file_name: z.string().optional(), file_content_type: z.string().optional(),
    },
    async (args) => {
      const { mpn, key, type, file_base64, file_name, file_content_type, ...meta } = args;
      if (!key || !key.trim()) {
        return { content: [{ type: 'text', text: '❌ API key is required for push. Please provide your key.' }] };
      }
      try {
        const fields = { mpn, type };
        for (const [k, v] of Object.entries(meta)) { if (v) fields[k] = v; }
        let fileField = null;
        if (file_base64 && type !== 'metadata') {
          fileField = { fieldName: 'file', filename: file_name || `${mpn}-${type}.${isPng(type) ? 'png' : 'pdf'}`, contentType: file_content_type || (isPng(type) ? 'image/png' : 'application/pdf'), buffer: Buffer.from(file_base64, 'base64') };
        }
        const { body: formBody, contentType } = buildFormData(fields, fileField);
        const { status, body } = await fetchRetry(`${BASE_URL}/api/Claude/push`, { method: 'POST', headers: { 'Content-Type': contentType }, body: formBody });
        if (status !== 200) return { content: [{ type: 'text', text: `❌ Push failed — HTTP ${status}: ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Push OK — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Push error: ${err.message}` }] };
      }
    }
  );

  // ── publish ─────────────────────────────────────────────────────────────

  server.tool(
    'publish',
    'Publish file or metadata to KanexPro production (POST /publish). Key is REQUIRED as form field — user must provide it. ⚠️ ALWAYS ASK USER FOR CONFIRMATION AND KEY BEFORE CALLING.',
    {
      sku: z.string().describe('Product SKU'),
      key: z.string().describe('API key — required, no default'),
      type: z.enum(TYPES).describe('Publish type'),
      title: z.string().optional(), subtitle: z.string().optional(),
      meta_description: z.string().optional(), meta_keywords: z.string().optional(),
      overview_html: z.string().optional(), features_html: z.string().optional(),
      specs_html: z.string().optional(), faq_json: z.string().optional(),
      file_base64: z.string().optional().describe('Base64-encoded file'),
      file_name: z.string().optional(), file_content_type: z.string().optional(),
    },
    async (args) => {
      const { sku, key, type, file_base64, file_name, file_content_type, ...meta } = args;
      if (!key || !key.trim()) {
        return { content: [{ type: 'text', text: '❌ API key is required for publish. Please provide your key.' }] };
      }
      try {
        const fields = { sku, type, key };
        for (const [k, v] of Object.entries(meta)) { if (v) fields[k] = v; }
        let fileField = null;
        if (file_base64 && type !== 'metadata') {
          fileField = { fieldName: 'file', filename: file_name || `${sku}-${type}.${isPng(type) ? 'png' : 'pdf'}`, contentType: file_content_type || (isPng(type) ? 'image/png' : 'application/pdf'), buffer: Buffer.from(file_base64, 'base64') };
        }
        const { body: formBody, contentType } = buildFormData(fields, fileField);
        const { status, body } = await fetchRetry(`${BASE_URL}/api/Claude/publish`, { method: 'POST', headers: { 'Content-Type': contentType }, body: formBody });
        if (status !== 200) return { content: [{ type: 'text', text: `❌ Publish failed — HTTP ${status}: ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: `✅ Published — ${JSON.stringify(body)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Publish error: ${err.message}` }] };
      }
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ── Hostinger VPS Tools ──────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // ── vps_list ───────────────────────────────────────────────────────────

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

  // ── vps_info ───────────────────────────────────────────────────────────

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
        if (status === 401) return { content: [{ type: 'text', text: '❌ 401 Unauthorized — invalid Hostinger API token.' }] };
        if (status === 404) return { content: [{ type: 'text', text: `❌ 404 — VM ${vm_id} not found.` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── vps_start ──────────────────────────────────────────────────────────

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

  // ── vps_stop ───────────────────────────────────────────────────────────

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

  // ── vps_restart ────────────────────────────────────────────────────────

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

  // ── vps_set_hostname ───────────────────────────────────────────────────

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

  // ── vps_set_root_password ──────────────────────────────────────────────

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

  // ── vps_actions ────────────────────────────────────────────────────────

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

  // ── vps_metrics ────────────────────────────────────────────────────────

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

  // ── vps_firewall_list ──────────────────────────────────────────────────

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

  // ── vps_firewall_rules ─────────────────────────────────────────────────

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

  // ── vps_firewall_activate ──────────────────────────────────────────────

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

  // ── vps_backups ────────────────────────────────────────────────────────

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

  // ── vps_create_snapshot ────────────────────────────────────────────────

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

  // ── vps_restore_backup ─────────────────────────────────────────────────

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

  // ── vps_post_install_scripts ───────────────────────────────────────────

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

  // ── vps_create_post_install ────────────────────────────────────────────

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

  // ── vps_ssh_keys ───────────────────────────────────────────────────────

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

  // ── vps_attach_ssh_key ─────────────────────────────────────────────────

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

  // ── vps_os_templates ───────────────────────────────────────────────────

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

  // ── vps_data_centers ───────────────────────────────────────────────────

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

  // ── vps_recreate ───────────────────────────────────────────────────────

  server.tool(
    'vps_recreate',
    'Recreate (reinstall OS) a Hostinger VPS. ⚠️ DESTRUCTIVE — all data will be lost. Ask user for confirmation AND key.',
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

  // ── vps_terminal ────────────────────────────────────────────────────────
  // SSH into the VPS and execute a shell command. Returns stdout + stderr.
  // Private key is read from env var HOSTINGER_SSH_KEY or file HOSTINGER_SSH_KEY_FILE.

  server.tool(
    'vps_terminal',
    'Execute a shell command on a Hostinger VPS via SSH. Returns stdout and stderr. SSH private key is read from env var HOSTINGER_SSH_KEY (the key contents) or HOSTINGER_SSH_KEY_FILE (path to key file). Commands run as root by default. ⚠️ Ask user for confirmation before running destructive commands.',
    {
      host: z.string().describe('VPS IP address or hostname'),
      command: z.string().describe('Shell command to execute on the VPS'),
      username: z.string().optional().describe('SSH username (default: root)'),
      port: z.number().optional().describe('SSH port (default: 22)'),
      timeout: z.number().optional().describe('Command timeout in seconds (default: 30)'),
    },
    async ({ host, command, username, port, timeout }) => {
      // Resolve private key from env
      let privateKey = process.env.HOSTINGER_SSH_KEY;
      if (!privateKey && process.env.HOSTINGER_SSH_KEY_FILE) {
        try {
          const { readFileSync } = await import('fs');
          privateKey = readFileSync(process.env.HOSTINGER_SSH_KEY_FILE, 'utf-8');
        } catch (err) {
          return { content: [{ type: 'text', text: `❌ Cannot read SSH key file: ${err.message}` }] };
        }
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

  return server;
}

// ── Transport: HTTP (Streamable HTTP) ───────────────────────────────────────

async function startHTTP() {
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // CORS for Claude.ai
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    if (_req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'kanexpro-api', version: '1.3.0' });
  });

  // OAuth discovery — return proper 404 so Claude.ai knows this is authless
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.status(404).json({ error: 'OAuth not supported — this server is authless' });
  });
  app.get('/.well-known/openid-configuration', (_req, res) => {
    res.status(404).json({ error: 'OAuth not supported — this server is authless' });
  });

  // HEAD — Claude.ai protocol discovery (on both / and /mcp)
  const headHandler = (_req, res) => {
    res.setHeader('MCP-Protocol-Version', '2024-11-05');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end();
  };
  app.head('/', headHandler);
  app.head('/mcp', headHandler);

  // MCP POST handler — stateless (new server per request)
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
  // Serve MCP on both / and /mcp so either URL works as connector
  app.post('/', mcpPostHandler);
  app.post('/mcp', mcpPostHandler);

  // Reject GET/DELETE on MCP endpoints per spec
  const methodNotAllowed = (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
  app.delete('/', methodNotAllowed);

  // GET / — server info (not MCP, just so it doesn't 404)
  app.get('/', (_req, res) => {
    res.json({ server: 'kanexpro-api', version: '1.3.0', mcp: '/mcp', health: '/health' });
  });

  // Catch-all — return JSON 404 instead of HTML (prevents Claude.ai auth confusion)
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, '0.0.0.0', (err) => {
    if (err) { console.error('Failed to start:', err); process.exit(1); }
    console.log(`KanexPro MCP Server v1.3.0 — HTTP on port ${PORT}`);
    console.log(`  MCP endpoint: http://0.0.0.0:${PORT}/mcp (or /)`);
    console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
  });
}

// ── Transport: stdio ────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('KanexPro MCP Server v1.3.0 — stdio');
}

// ── Main ────────────────────────────────────────────────────────────────────

if (USE_STDIO) {
  startStdio().catch(err => { console.error('Fatal:', err); process.exit(1); });
} else {
  startHTTP().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

process.on('SIGINT', () => { console.log('Shutting down...'); process.exit(0); });
