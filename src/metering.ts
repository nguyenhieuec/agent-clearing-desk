import type { AgentKey, StructuredClearingError, ToolPricing } from './types.ts';

/**
 * Standard pricing catalog anchored to docs/apify-publish.md:13-16.
 * All values in cents (1 cent = $0.01 USD).
 */
export const TOOL_CATALOG: Record<
  string,
  { costCents: number; priceCents: number; marginCents: number; aliases: string[] }
> = {
  'job-boards': {
    costCents: 0.15, // $0.0015 per call
    priceCents: 0.2, // $0.0020 per call
    marginCents: 0.05,
    aliases: ['list_jobs', 'find_company_jobs'],
  },
  'app-reviews': {
    costCents: 0.015, // $0.00015 per call
    priceCents: 0.025, // $0.00025 per call
    marginCents: 0.01,
    aliases: ['get_app_reviews'],
  },
  'yt-transcripts': {
    costCents: 0.4, // $0.0040 per call
    priceCents: 0.5, // $0.0050 per call
    marginCents: 0.1,
    aliases: ['get_transcript'],
  },
  'shop-duty': {
    costCents: 0.5, // $0.0050 per call
    priceCents: 1.0, // $0.0100 per call (1 cent)
    marginCents: 0.5,
    aliases: ['eu_duty_estimate', 'customs_data_gap_check', 'landed_cost_estimate'],
  },
  tariffs: {
    costCents: 0.5,
    priceCents: 1.0,
    marginCents: 0.5,
    aliases: ['find_tariff_codes', 'get_duty_rate'],
  },
  'eu-business': {
    costCents: 0.5,
    priceCents: 1.0,
    marginCents: 0.5,
    aliases: ['check_vat_number', 'find_company_lei'],
  },
  check_agent_balance: {
    costCents: 0,
    priceCents: 0,
    marginCents: 0,
    aliases: ['balance'],
  },
  get_call_receipt: {
    costCents: 0,
    priceCents: 0,
    marginCents: 0,
    aliases: ['receipt'],
  },
};

/**
 * Normalize tool name to canonical or alias.
 */
export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  for (const [canonical, data] of Object.entries(TOOL_CATALOG)) {
    if (canonical === lower || data.aliases.includes(lower)) {
      return canonical;
    }
  }
  return lower;
}

function parseOverrides(raw: string): Record<string, number> {
  try {
    return JSON.parse(raw || '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Resolve catalog pricing for a tool without a key.
 */
export function resolveCatalogPricing(requestedTool: string): ToolPricing {
  const normName = normalizeToolName(requestedTool);
  const entry = TOOL_CATALOG[normName] || TOOL_CATALOG[requestedTool];
  if (entry) {
    return {
      toolName: requestedTool,
      costCents: entry.costCents,
      priceCents: entry.priceCents,
      marginCents: entry.marginCents,
    };
  }
  return {
    toolName: requestedTool,
    costCents: 0,
    priceCents: 5,
    marginCents: 5,
  };
}

/**
 * Resolve tool pricing for an agent key, taking key-specific overrides into account.
 */
export function resolveToolPricing(key: AgentKey, requestedTool: string): ToolPricing {
  const normName = normalizeToolName(requestedTool);
  const overrides = parseOverrides(key.tool_pricing_overrides);
  const overridePrice = overrides[requestedTool] ?? overrides[normName];

  if (overridePrice !== undefined) {
    const costCents = TOOL_CATALOG[normName]?.costCents ?? 0;
    return {
      toolName: requestedTool,
      costCents,
      priceCents: overridePrice,
      marginCents: Math.max(0, overridePrice - costCents),
    };
  }

  const catalogEntry = TOOL_CATALOG[normName] || TOOL_CATALOG[requestedTool];
  if (catalogEntry) {
    return {
      toolName: requestedTool,
      costCents: catalogEntry.costCents,
      priceCents: catalogEntry.priceCents,
      marginCents: catalogEntry.marginCents,
    };
  }

  const priceCents = key.per_call_price_cents > 0 ? key.per_call_price_cents : 5;
  return {
    toolName: requestedTool,
    costCents: 0,
    priceCents,
    marginCents: priceCents,
  };
}

/**
 * Check if the tool is permitted by the agent key's allowlist.
 */
export function isToolAllowed(key: AgentKey, requestedTool: string): boolean {
  let list: string[] = ['*'];
  try {
    list = JSON.parse(key.allowlist || '["*"]');
  } catch {
    list = ['*'];
  }

  if (list.includes('*')) {
    return true;
  }

  const norm = normalizeToolName(requestedTool);
  return list.some(item => {
    const itemNorm = normalizeToolName(item);
    return item === requestedTool || itemNorm === norm || item === norm;
  });
}

/**
 * Check if key has sufficient budget for the call.
 */
export function checkBudget(
  key: AgentKey,
  priceCents: number
): { allowed: boolean; remainingCents: number; reason?: string } {
  const remainingCents = key.budget_cents - key.spent_cents;
  if (priceCents <= 0) {
    return { allowed: true, remainingCents };
  }
  if (remainingCents < priceCents) {
    const remUsd = (remainingCents / 100).toFixed(4);
    const priceUsd = (priceCents / 100).toFixed(4);
    return {
      allowed: false,
      remainingCents,
      reason: `Agent key budget exceeded: remaining balance $${remUsd} is less than call price $${priceUsd}`,
    };
  }
  return { allowed: true, remainingCents };
}

/**
 * Format structured error for budget exceeded.
 */
export function createBudgetExceededError(
  key: AgentKey,
  toolName: string,
  priceCents: number,
  receiptId?: string
): StructuredClearingError {
  const remUsd = ((key.budget_cents - key.spent_cents) / 100).toFixed(4);
  const priceUsd = (priceCents / 100).toFixed(4);
  return {
    error: {
      code: 'budget_exceeded',
      message: `Agent key budget exceeded: remaining balance $${remUsd} is less than call price $${priceUsd}`,
      key_id: key.key_id,
      tool_name: toolName,
      budget_cents: key.budget_cents,
      spent_cents: key.spent_cents,
      call_price_cents: priceCents,
      receipt_id: receiptId,
    },
  };
}

/**
 * Format structured error for tool not in allowlist.
 */
export function createToolNotAllowedError(
  key: AgentKey,
  toolName: string
): StructuredClearingError {
  return {
    error: {
      code: 'tool_not_allowed',
      message: `Tool '${toolName}' is not permitted by agent key allowlist`,
      key_id: key.key_id,
      tool_name: toolName,
    },
  };
}
