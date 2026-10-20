import type { JsonSchema, McpToolDefinition, Millicents } from './types.ts';
import schemas from './tool-schemas.json';

/**
 * Where a governed tool runs. The desk is one gateway in front of several MCP and
 * REST upstreams; each upstream keeps its own credentials, which agents never see.
 */
export type UpstreamTarget =
  | { kind: 'mcp'; upstream: string; url: string; tool: string; auth: 'openkrill' | 'none' }
  | { kind: 'rest'; upstream: string; tool: string };

export interface GovernedTool {
  name: string;
  title: string;
  description: string;
  target: UpstreamTarget;
  /** Contract rate the operator pays the upstream per call. */
  costMc: Millicents;
  /** Default list price charged to the agent key per successful call. */
  priceMc: Millicents;
  timeoutMs: number;
  inputSchema: JsonSchema;
  /** True for a tool an operator added at run time (custom_tools), false for a built-in one. */
  custom: boolean;
}

const OPENKRILL_MCP = (plugin: string, tool: string): UpstreamTarget => ({
  kind: 'mcp',
  upstream: 'openkrill',
  url: `/plugins/${plugin}/mcp`,
  tool,
  auth: 'openkrill',
});

const SCHEMAS = schemas as Record<string, JsonSchema>;

type BuiltinTool = Omit<GovernedTool, 'inputSchema' | 'custom'>;

/** Built-in tools, in the order agents see them. Schemas come from scripts/sync-tool-schemas.mjs. */
const BUILTIN_DEFINITIONS: BuiltinTool[] = [
  {
    name: 'eu_duty_estimate',
    title: 'EU duty on a low-value consignment',
    description:
      'EUR 3 per item EU customs duty on a consignment up to EUR 150 (Reg. (EU) 2026/382). Metered by Agent Clearing Desk.',
    target: OPENKRILL_MCP('shop-duty', 'eu_duty_estimate'),
    costMc: 500,
    priceMc: 1000,
    timeoutMs: 15_000,
  },
  {
    name: 'find_tariff_codes',
    title: 'HS / HTS tariff code lookup',
    description:
      'Candidate HS, HTS or UK commodity codes for a product, with duty rates, for GB or US imports. Metered by Agent Clearing Desk.',
    target: OPENKRILL_MCP('tariffs', 'find_tariff_codes'),
    costMc: 500,
    priceMc: 1000,
    timeoutMs: 15_000,
  },
  {
    name: 'check_vat_number',
    title: 'EU VAT number check (VIES)',
    description:
      'Check an EU VAT number against the official VIES registry. Metered by Agent Clearing Desk.',
    target: OPENKRILL_MCP('eu-business', 'check_vat_number'),
    costMc: 500,
    priceMc: 1000,
    timeoutMs: 15_000,
  },
  {
    name: 'list_jobs',
    title: 'Open jobs from company careers pages',
    description:
      'Open roles from Greenhouse, Lever, Ashby, Workday and other careers pages. Metered by Agent Clearing Desk.',
    target: { kind: 'rest', upstream: 'openkrill', tool: 'job-boards' },
    costMc: 150,
    priceMc: 200,
    timeoutMs: 25_000,
  },
  {
    name: 'get_app_reviews',
    title: 'App Store and Google Play reviews',
    description: 'Reviews and ratings for iOS and Android apps. Metered by Agent Clearing Desk.',
    target: { kind: 'rest', upstream: 'openkrill', tool: 'app-reviews' },
    costMc: 15,
    priceMc: 25,
    timeoutMs: 25_000,
  },
  {
    name: 'get_transcript',
    title: 'YouTube transcript',
    description: 'Transcript of a YouTube video. Metered by Agent Clearing Desk.',
    target: { kind: 'rest', upstream: 'openkrill', tool: 'yt-transcripts' },
    costMc: 400,
    priceMc: 500,
    timeoutMs: 25_000,
  },
  {
    name: 'ask_repo_question',
    title: 'Ask about a GitHub repository (DeepWiki)',
    description:
      "Answer a question about a public GitHub repository from its DeepWiki. Runs on DeepWiki's public MCP server; metered by Agent Clearing Desk.",
    target: {
      kind: 'mcp',
      upstream: 'deepwiki',
      url: 'https://mcp.deepwiki.com/mcp',
      tool: 'ask_wiki_question',
      auth: 'none',
    },
    costMc: 0,
    priceMc: 1000,
    timeoutMs: 45_000,
  },
];

export const BUILTIN_TOOLS: GovernedTool[] = BUILTIN_DEFINITIONS.map(t => ({
  ...t,
  inputSchema: SCHEMAS[t.name],
  custom: false,
}));

const BY_NAME = new Map(BUILTIN_TOOLS.map(t => [t.name, t]));

export function findBuiltinTool(name: string): GovernedTool | undefined {
  return BY_NAME.get(name);
}

/** Free tools the desk answers itself; they never reach an upstream or a budget. */
export const DESK_TOOLS: McpToolDefinition[] = [
  {
    name: 'check_agent_balance',
    title: 'Check my budget',
    description: 'Budget, spend and remaining allowance of the calling agent key. Free.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_call_receipt',
    title: 'Get a signed receipt',
    description:
      'Fetch one of my signed clearing receipts by id, with its Ed25519 signature check. Free.',
    inputSchema: {
      type: 'object',
      properties: { receipt_id: { type: 'string', description: 'Receipt id, rcpt_...' } },
      required: ['receipt_id'],
    },
  },
];

/** MCP tools/list entries for governed tools plus the free desk tools. */
export function mcpToolList(tools: GovernedTool[]): McpToolDefinition[] {
  return [
    ...tools.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
    ...DESK_TOOLS,
  ];
}
