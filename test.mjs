import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const PORT = 3002;
const server = spawn('node', ['server.mjs'], {
  cwd: '/home/claude/kanexpro-mcp',
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});
await setTimeout(2500);

function parseSSE(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) { try { return JSON.parse(line.slice(6)); } catch {} }
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function mcp(id, method, params = {}) {
  const res = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return parseSSE(await res.text());
}

function toolResult(r) {
  return r?.result?.content?.[0]?.text || r?.error?.message || '';
}

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

try {
  console.log('KanexPro MCP Server v1.2.0 — Test Suite\n');

  // 1. Health
  console.log('1. Health check');
  const h = await fetch(`http://localhost:${PORT}/health`).then(r => r.json());
  check('GET /health', h.status === 'ok' && h.version === '1.2.0', h.version);

  // 2. Init
  console.log('2. MCP Initialize');
  const init = await mcp(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
  check('Handshake', init?.result?.serverInfo?.name === 'kanexpro-api', init?.result?.serverInfo?.version);

  // 3. Tools list — auth model
  console.log('3. Tools list & auth model');
  const tl = await mcp(2, 'tools/list');
  const tools = tl?.result?.tools || [];
  check('4 tools registered', tools.length === 4, tools.map(t => t.name).join(', '));

  const cms = tools.find(t => t.name === 'cmslookup');
  const lst = tools.find(t => t.name === 'list');
  const psh = tools.find(t => t.name === 'push');
  const pub = tools.find(t => t.name === 'publish');
  check('cmslookup does NOT require key', !cms?.inputSchema?.required?.includes('key'));
  check('list key is optional', !lst?.inputSchema?.required?.includes('key'));
  check('push requires key', psh?.inputSchema?.required?.includes('key'));
  check('publish requires key', pub?.inputSchema?.required?.includes('key'));

  // 4. cmslookup — no key needed
  console.log('4. cmslookup — no key (should work)');
  const lookup = await mcp(3, 'tools/call', { name: 'cmslookup', arguments: { sku: 'COL-HUD-21' } });
  const txt = toolResult(lookup);
  let d; try { d = JSON.parse(txt); } catch { d = null; }
  check('Returns product data', d?.sku === 'COL-HUD-21', `${d?.title?.slice(0, 50)} | $${d?.msrp}`);

  // 5. list WITHOUT key — no MSRP
  console.log('5. list — without key (MSRP hidden)');
  const listNoKey = await mcp(4, 'tools/call', { name: 'list', arguments: { category: 'AV Over IP', subcategory: 'JPEG2000' } });
  const lnk = toolResult(listNoKey);
  let prodsNoKey; try { prodsNoKey = JSON.parse(lnk)?.products; } catch { prodsNoKey = null; }
  check('Returns products', Array.isArray(prodsNoKey) && prodsNoKey.length > 0, `${prodsNoKey?.length} products`);
  check('MSRP stripped', prodsNoKey?.[0] && !('msrp' in prodsNoKey[0]));
  check('stock stripped', prodsNoKey?.[0] && !('stock' in prodsNoKey[0]));

  // 6. list WITH key — MSRP visible
  console.log('6. list — with key (MSRP visible)');
  const listKey = await mcp(5, 'tools/call', { name: 'list', arguments: { category: 'AV Over IP', subcategory: 'JPEG2000', key: '9876' } });
  const lk = toolResult(listKey);
  let prodsKey; try { prodsKey = JSON.parse(lk)?.products; } catch { prodsKey = null; }
  check('MSRP present', prodsKey?.[0] && ('msrp' in prodsKey[0]), `$${prodsKey?.[0]?.msrp}`);
  check('stock present', prodsKey?.[0] && ('stock' in prodsKey[0]));

  // 7. list with WRONG key — MSRP hidden
  console.log('7. list — wrong key (MSRP hidden)');
  const listBad = await mcp(6, 'tools/call', { name: 'list', arguments: { category: 'AV Over IP', subcategory: 'JPEG2000', key: '0000' } });
  const lb = toolResult(listBad);
  let prodsBad; try { prodsBad = JSON.parse(lb)?.products; } catch { prodsBad = null; }
  check('MSRP stripped with wrong key', prodsBad?.[0] && !('msrp' in prodsBad[0]));

  // 8. push without key — rejected
  console.log('8. push — without key (rejected)');
  const pushNoKey = await mcp(7, 'tools/call', { name: 'push', arguments: { mpn: 'TEST', type: 'metadata' } });
  const pnk = toolResult(pushNoKey);
  check('Push rejects missing key', pnk.includes('required') || pnk.includes('key') || pnk.includes('validation'), pnk.slice(0, 80));

  // 9. 404
  console.log('9. cmslookup — 404');
  const nf = await mcp(8, 'tools/call', { name: 'cmslookup', arguments: { sku: 'FAKE-999' } });
  check('404 clean message', toolResult(nf).includes('404'));

  // Summary
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`${'═'.repeat(50)}`);

} catch (err) {
  console.error('TEST ERROR:', err.message);
} finally {
  server.kill();
  process.exit(0);
}
