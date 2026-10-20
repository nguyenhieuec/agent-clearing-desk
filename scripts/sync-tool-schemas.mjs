#!/usr/bin/env node
// Copies the input schemas of every governed tool from its upstream into
// src/tool-schemas.json, so the desk advertises exactly what the upstream accepts
// and passes the agent's arguments through without rewriting them.
// Run: node scripts/sync-tool-schemas.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'src', 'tool-schemas.json');
const OPENKRILL = 'https://api.openkrill.app';

// desk tool name -> where its schema lives upstream
const SOURCES = {
  eu_duty_estimate: { mcp: `${OPENKRILL}/plugins/shop-duty/mcp`, tool: 'eu_duty_estimate' },
  find_tariff_codes: { mcp: `${OPENKRILL}/plugins/tariffs/mcp`, tool: 'find_tariff_codes' },
  check_vat_number: { mcp: `${OPENKRILL}/plugins/eu-business/mcp`, tool: 'check_vat_number' },
  list_jobs: { rest: 'job-boards' },
  get_app_reviews: { rest: 'app-reviews' },
  get_transcript: { rest: 'yt-transcripts' },
  ask_repo_question: { mcp: 'https://mcp.deepwiki.com/mcp', tool: 'ask_wiki_question' },
};

async function readRpc(res) {
  const text = await res.text();
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) return JSON.parse(text);
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(line.slice(5));
}

async function mcpTools(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return (await readRpc(res)).result.tools;
}

async function main() {
  const restTools = (await (await fetch(`${OPENKRILL}/v1/tools`)).json()).tools;
  const mcpCache = new Map();
  const out = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    let tool;
    if (src.rest) {
      tool = restTools.find(t => t.name === src.rest);
    } else {
      if (!mcpCache.has(src.mcp)) mcpCache.set(src.mcp, await mcpTools(src.mcp));
      tool = mcpCache.get(src.mcp).find(t => t.name === src.tool);
    }
    if (!tool) throw new Error(`upstream tool missing for ${name}`);
    out[name] = tool.inputSchema;
  }
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${Object.keys(out).length} schemas to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
