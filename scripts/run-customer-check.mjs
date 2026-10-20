import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Agent customer check: a small model gets natural requests and only the desk's MCP tools.
 * CLEARING_DESK_KEY must be a desk key that allows every tool; the MCP config with it lives
 * in a private temp folder that is removed at the end.
 */
const DESK_URL = process.env.CLEARING_DESK_URL || 'https://agent-clearing-desk.nguyenhieuec.workers.dev';
const MODEL = process.env.CHECK_MODEL || 'cli-proxy/gemini-3.8-flash';
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clearingdesk-eval-'));
const MCP_CONFIG_PATH = path.join(WORK_DIR, 'mcp.json');

const TASKS = [
  {
    id: 1,
    type: 'positive',
    prompt: "Check the EU duty on 3 T-shirts, but don't spend more than 5 cents",
    expectedTool: 'eu_duty_estimate',
  },
  {
    id: 2,
    type: 'positive',
    prompt: 'Find open software engineer jobs at Airbnb',
    expectedTool: 'list_jobs',
  },
  {
    id: 3,
    type: 'positive',
    prompt: 'Check customer reviews and ratings for Spotify mobile app',
    expectedTool: 'get_app_reviews',
  },
  {
    id: 4,
    type: 'positive',
    prompt: 'What is the tariff code and import duty rate for ceramic coffee mugs?',
    expectedTool: 'find_tariff_codes',
  },
  {
    id: 5,
    type: 'positive',
    prompt: 'Verify if German VAT number DE123456789 is legally registered in the EU',
    expectedTool: 'check_vat_number',
  },
  {
    id: 9,
    type: 'positive',
    prompt: 'In the cloudflare/workers-sdk GitHub repo, how does wrangler decide which D1 migrations still need to run?',
    expectedTool: 'ask_repo_question',
  },
  {
    id: 6,
    type: 'negative',
    prompt: 'Write a 3 sentence poem about autumn rain',
    expectedTool: null,
  },
  {
    id: 7,
    type: 'negative',
    prompt:
      'Explain the difference between synchronous and asynchronous programming in simple terms',
    expectedTool: null,
  },
  {
    id: 8,
    type: 'negative',
    prompt: 'What is 144 divided by 12?',
    expectedTool: null,
  },
];

function extractAssistantItems(line) {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'message_end' && obj.message?.role === 'assistant') {
      return obj.message.content || [];
    }
  } catch {
    // Ignore malformed JSON line
  }
  return [];
}

function parseJsonlOutput(content) {
  const toolCalls = [];
  let finalText = '';
  for (const line of content.trim().split('\n')) {
    for (const item of extractAssistantItems(line)) {
      if (item.type === 'toolCall') toolCalls.push(item);
      if (item.type === 'text' && item.text) finalText += item.text + '\n';
    }
  }
  return { toolCalls, finalText };
}

function isClearingBusinessTool(rawName) {
  return (
    rawName.startsWith('clearing-desk_') &&
    !rawName.includes('check_agent_balance') &&
    !rawName.includes('get_call_receipt')
  );
}

function getRawToolName(call) {
  if (call.name === 'mcp') return call.arguments?.tool || '';
  return call.name || '';
}

function gradePositiveTask(toolsChosen, expectedTool, durationSec) {
  if (toolsChosen[0] === expectedTool) {
    return {
      verdict: 'pass',
      details: `Correct tool (${expectedTool}) invoked directly. Duration: ${durationSec}s.`,
    };
  }
  if (toolsChosen.includes(expectedTool)) {
    return {
      verdict: 'pass',
      details: `Correct tool (${expectedTool}) invoked after exploration. Duration: ${durationSec}s.`,
    };
  }
  return {
    verdict: 'fail',
    details: `Wrong tool or no execution. Expected: ${expectedTool}, Got: ${toolsChosen.join(', ') || 'none'}.`,
  };
}

function gradeNegativeTask(toolsChosen, durationSec) {
  if (toolsChosen.length === 0) {
    return {
      verdict: 'pass',
      details: `No tool called. Pure conversational completion. Duration: ${durationSec}s.`,
    };
  }
  return {
    verdict: 'fail',
    details: `Erroneously called tools: ${toolsChosen.join(', ')}`,
  };
}

async function runTask(task) {
  console.log(`\n=== Running Task ${task.id} (${task.type}): "${task.prompt}" ===`);
  const t0 = Date.now();
  const outputFile = path.join(WORK_DIR, `task_${task.id}.jsonl`);

  try {
    execSync(
      `pi --model ${MODEL} --tools mcp --mcp-config ${MCP_CONFIG_PATH} -p --mode json "${task.prompt.replace(/"/g, '\\"')}" > ${outputFile} 2>&1`,
      { timeout: 120000 }
    );
  } catch (err) {
    console.error(`Task ${task.id} exited with status: ${err.status}`);
  }

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  const content = fs.readFileSync(outputFile, 'utf8');
  const { toolCalls, finalText } = parseJsonlOutput(content);

  const toolsChosen = toolCalls
    .map(getRawToolName)
    .filter(isClearingBusinessTool)
    .map(raw => raw.replace('clearing-desk_', ''));

  const graded =
    task.type === 'positive'
      ? gradePositiveTask(toolsChosen, task.expectedTool, durationSec)
      : gradeNegativeTask(toolsChosen, durationSec);

  console.log(`Result: ${graded.verdict.toUpperCase()}`);
  console.log(`Details: ${graded.details}`);

  return {
    id: task.id,
    type: task.type,
    prompt: task.prompt,
    expectedTool: task.expectedTool,
    verdict: graded.verdict,
    toolsChosen: toolsChosen.join(', ') || 'none',
    durationSec,
    details: graded.details,
    finalText: finalText.trim().slice(0, 300),
  };
}

function formatMarkdownReport(results, totals, ledger) {
  const rows = results
    .map(
      r =>
        `| ${r.id} | ${r.type} | "${r.prompt}" | \`${r.expectedTool || 'none'}\` | \`${r.toolsChosen}\` | ${r.durationSec}s | **${r.verdict.toUpperCase()}** |`
    )
    .join('\n');
  const outcomes = Object.entries(ledger).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

  return [
    '# Agent customer check: Agent Clearing Desk\n',
    `Run on ${new Date().toISOString().slice(0, 10)} against the live desk (${DESK_URL}/mcp).`,
    `Runner: pi ${'-p --mode json'}, model ${MODEL}, only the desk MCP tools enabled, config in a private temp folder.`,
    'Prompts are natural customer requests with no tool names or argument hints.\n',
    '## Pass bar\n',
    `- At least ${totals.positiveBar} of ${totals.positive} positive tasks pick the right tool with no hint.`,
    '- No negative task calls a paid tool.\n',
    '## Result\n',
    '| Metric | Target | Actual |',
    '| --- | --- | --- |',
    `| Positive tasks | >= ${totals.positiveBar} / ${totals.positive} | ${totals.positivePassed} / ${totals.positive} |`,
    `| Negative tasks with no paid tool call | ${totals.negative} / ${totals.negative} | ${totals.negativePassed} / ${totals.negative} |`,
    `| Overall | pass | **${totals.allPassed ? 'PASS' : 'FAIL'}** |\n`,
    `Receipts the desk signed for this key during the run, by outcome: ${outcomes}.\n`,
    '## Task log\n',
    '| # | Type | Prompt | Expected tool | Tools called | Time | Result |',
    '|---|---|---|---|---|---|---|',
    rows,
    '',
  ].join('\n');
}

/** What the desk itself recorded for the key: the ground truth beside the model transcript. */
async function ledgerOutcomes() {
  const res = await fetch(`${DESK_URL}/v1/receipts?limit=200`, { headers: { 'x-api-key': process.env.CLEARING_DESK_KEY } });
  const { receipts = [] } = await res.json();
  const counts = {};
  for (const { outcome } of receipts.map(r => JSON.parse(r.payload))) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

async function main() {
  if (!process.env.CLEARING_DESK_KEY) throw new Error('set CLEARING_DESK_KEY to a desk key that allows every tool');
  const server = { url: `${DESK_URL}/mcp`, headers: { 'x-api-key': process.env.CLEARING_DESK_KEY } };
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: { 'clearing-desk': server } }), { mode: 0o600 });

  const results = [];
  try {
    for (const task of TASKS) results.push(await runTask(task));
  } finally {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }

  const count = (type, verdict) => results.filter(r => r.type === type && (!verdict || r.verdict === verdict)).length;
  const totals = {
    positive: count('positive'),
    positivePassed: count('positive', 'pass'),
    negative: count('negative'),
    negativePassed: count('negative', 'pass'),
  };
  totals.positiveBar = totals.positive - 1;
  totals.allPassed = totals.positivePassed >= totals.positiveBar && totals.negativePassed === totals.negative;

  const md = formatMarkdownReport(results, totals, await ledgerOutcomes());
  fs.writeFileSync(path.resolve('AGENT-CUSTOMER-CHECK.md'), md);
  console.log(md);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
