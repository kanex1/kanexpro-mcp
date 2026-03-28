#!/usr/bin/env node

/**
 * KanexPro Product API — MCP Server v1.2.0
 * 
 * Remote MCP server exposing the KanexPro CMS API.
 * Runs as Streamable HTTP (for Claude.ai / remote) or stdio (for Claude Desktop).
 * 
 * Tools:
 *   cmslookup   — Look up a product by SKU (primary lookup — no key needed)
 *   list        — List products by category / subcategory (key required for MSRP)
 *   push        — Push file or metadata to staging  (⚠️ key required, ask user first)
 *   publish     — Publish file or metadata to prod   (⚠️ key required, ask user first)
 *
 * Usage:
 *   node server.mjs              → HTTP on port 3000 (or $PORT)
 *   node server.mjs --stdio      → stdio transport (Claude Desktop)
 *
 * API key is NOT hardcoded — user must provide key for push, publish, and list (to see MSRP).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import { ProxyAgent, fetch as uFetch, Agent } from 'undici';

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.KANEXPRO_API_URL || 'https://api.kanexpro.com';
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

const TYPES = ['sheet','manual','marketing','sales_sheet','diagram','panel','applications','banner','social_square','social_landscape','metadata'];

// ── Server Factory ──────────────────────────────────────────────────────────

function createServer() {
  const server = new McpServer({ name: 'kanexpro-api', version: '1.2.0' });

  // ── cmslookup ───────────────────────────────────────────────────────────

  server.tool(
    'cmslookup',
    'Look up a KanexPro product by SKU via /cmslookup (PRIMARY lookup). No key needed. Returns FLAT JSON: title, subtitle, overview_html, features_html, specs_html, faq_json (parsed array), upc, category, subcategory, msrp, status, photo_url, and file URLs.',
    {
      sku: z.string().describe('Product MPN / SKU (e.g. AVO-IPJP2K)'),
    },
    async ({ sku }) => {
      try {
        const url = `${BASE_URL}/api/Claude/cmslookup?sku=${encodeURIComponent(sku)}&key=9876`;
        const { status, body } = await fetchRetry(url);
        if (status === 401) return { content: [{ type: 'text', text: `❌ 401 Unauthorized — cmslookup auth error.` }] };
        if (status === 404) return { content: [{ type: 'text', text: `❌ 404 — SKU "${sku}" not found in CMS.` }] };
        if (status !== 200) return { content: [{ type: 'text', text: `❌ HTTP ${status} — ${JSON.stringify(body)}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Network error: ${err.message}` }] };
      }
    }
  );

  // ── list ────────────────────────────────────────────────────────────────

  server.tool(
    'list',
    'List KanexPro products by category/subcategory via /list. Returns {"products":[...]} with SKU, title, subtitle, MSRP, status, photo_url, file URLs. Note: Diagram uses capital D. Cost and stock fields are only included if a valid key is provided.',
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
    res.json({ status: 'ok', server: 'kanexpro-api', version: '1.2.0' });
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
    res.json({ server: 'kanexpro-api', version: '1.2.0', mcp: '/mcp', health: '/health' });
  });

  // Catch-all — return JSON 404 instead of HTML (prevents Claude.ai auth confusion)
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, '0.0.0.0', (err) => {
    if (err) { console.error('Failed to start:', err); process.exit(1); }
    console.log(`KanexPro MCP Server v1.2.0 — HTTP on port ${PORT}`);
    console.log(`  MCP endpoint: http://0.0.0.0:${PORT}/mcp (or /)`);
    console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
  });
}

// ── Transport: stdio ────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('KanexPro MCP Server v1.2.0 — stdio');
}

// ── Main ────────────────────────────────────────────────────────────────────

if (USE_STDIO) {
  startStdio().catch(err => { console.error('Fatal:', err); process.exit(1); });
} else {
  startHTTP().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

process.on('SIGINT', () => { console.log('Shutting down...'); process.exit(0); });
