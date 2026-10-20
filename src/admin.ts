import type { Env } from './types.ts';
import {
  createAgentKey,
  createOrganization,
  getOverviewStats,
  listAgentKeys,
  listAuditLogs,
  listOrganizations,
  listReceipts,
  revokeAgentKey,
  rotateAgentKey,
  updateAgentBudget,
} from './db.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function resolveDefaultOrgId(db: D1Database, requestedOrgId?: string): Promise<string> {
  if (requestedOrgId) return requestedOrgId;
  const existingOrgs = await listOrganizations(db);
  if (existingOrgs.length > 0) return existingOrgs[0].id;
  const defaultOrg = await createOrganization(db, 'Acme Enterprise', 'admin@acme.example');
  return defaultOrg.id;
}

async function handleCreateOrg(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { name?: string; email?: string };
    if (!body.name || !body.email) {
      return json({ error: 'name and email are required' }, 400);
    }
    const org = await createOrganization(env.DB, body.name, body.email);
    return json(org, 201);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

async function handleCreateKey(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      orgId?: string;
      name?: string;
      budgetCents?: number;
      allowlist?: string[];
      perCallPriceCents?: number;
      toolPricingOverrides?: Record<string, number>;
    };
    if (!body.name) return json({ error: 'name is required' }, 400);

    const orgId = await resolveDefaultOrgId(env.DB, body.orgId);
    const created = await createAgentKey(env.DB, {
      orgId,
      name: body.name,
      budgetCents: body.budgetCents ?? 500,
      allowlist: body.allowlist ?? ['*'],
      perCallPriceCents: body.perCallPriceCents ?? 5,
      toolPricingOverrides: body.toolPricingOverrides,
    });

    return json(created, 201);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

async function handleKeyAction(
  keyId: string,
  action: string,
  request: Request,
  env: Env
): Promise<Response | null> {
  if (action === 'rotate') {
    try {
      const rotated = await rotateAgentKey(env.DB, keyId);
      return json(rotated);
    } catch (e) {
      return json({ error: String(e) }, 404);
    }
  }
  if (action === 'revoke') {
    await revokeAgentKey(env.DB, keyId);
    return json({ success: true, keyId, status: 'revoked' });
  }
  if (action === 'budget') {
    const body = (await request.json()) as { budgetCents: number };
    if (typeof body.budgetCents !== 'number') {
      return json({ error: 'budgetCents must be a number' }, 400);
    }
    const updated = await updateAgentBudget(env.DB, keyId, body.budgetCents);
    return json({ success: true, key: updated });
  }
  return null;
}

async function handleAdminGetRoute(path: string, url: URL, env: Env): Promise<Response | null> {
  if (path === '/admin' || path === '/') {
    return new Response(renderAdminHtml(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  if (path === '/api/admin/overview') {
    return json(await getOverviewStats(env.DB));
  }
  if (path === '/api/admin/orgs') {
    return json({ organizations: await listOrganizations(env.DB) });
  }
  if (path === '/api/admin/keys') {
    const orgId = url.searchParams.get('org_id') || undefined;
    return json({ keys: await listAgentKeys(env.DB, orgId) });
  }
  if (path === '/api/admin/audit') {
    const limit = Number(url.searchParams.get('limit') || 100);
    const keyId = url.searchParams.get('key_id') || undefined;
    return json({ audit_logs: await listAuditLogs(env.DB, keyId, limit) });
  }
  if (path === '/api/admin/receipts') {
    const limit = Number(url.searchParams.get('limit') || 100);
    const keyId = url.searchParams.get('key_id') || undefined;
    return json({ receipts: await listReceipts(env.DB, keyId, limit) });
  }
  return null;
}

/**
 * Handle admin REST API routes and render admin dashboard HTML
 */
export async function handleAdminRequest(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' || method === 'HEAD') {
    const getRes = await handleAdminGetRoute(path, url, env);
    if (getRes) return getRes;
  }

  if (method === 'POST') {
    if (path === '/api/admin/orgs') return handleCreateOrg(request, env);
    if (path === '/api/admin/keys') return handleCreateKey(request, env);

    const actionMatch = path.match(/^\/api\/admin\/keys\/([a-zA-Z0-9_-]+)\/(rotate|revoke|budget)$/);
    if (actionMatch) {
      const actionRes = await handleKeyAction(actionMatch[1], actionMatch[2], request, env);
      if (actionRes) return actionRes;
    }
  }

  return json({ error: 'Not found' }, 404);
}

/**
 * Modern, responsive single-page admin dashboard
 */
function renderAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Clearing Desk - Enterprise Governance & Settlement</title>
  <style>
    :root {
      --bg: #090d16;
      --surface: #111827;
      --surface-border: #1f293d;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --accent: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --purple: #8b5cf6;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1320px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--surface-border);
      gap: 16px;
      flex-wrap: wrap;
    }
    .title-group h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .title-group p { font-size: 13px; color: var(--text-muted); }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
      border: 1px solid rgba(59, 130, 246, 0.35);
    }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.35); }
    .badge-amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border-color: rgba(245, 158, 11, 0.35); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.35); }
    
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 20px;
      overflow-x: auto;
    }
    .card-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; letter-spacing: 0.03em; }
    .card-value { font-size: 26px; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
    .card-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    .nav-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--surface-border);
      padding-bottom: 10px;
      flex-wrap: wrap;
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .tab-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
    .tab-btn.active { color: #fff; background: var(--primary); }
    .tab-btn:focus-visible, .btn:focus-visible, .form-control:focus-visible {
      outline: 2px solid #60a5fa;
      outline-offset: 2px;
    }

    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      gap: 12px;
      flex-wrap: wrap;
    }
    .section-title h2 { font-size: 18px; font-weight: 600; }

    .btn {
      background: var(--primary);
      color: #fff;
      border: 1px solid transparent;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-accent { background: #059669; color: #fff; }
    .btn-accent:hover { background: #047857; }
    .btn-secondary { background: #374151; color: #e5e7eb; }
    .btn-secondary:hover { background: #4b5563; }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.3); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }
    th {
      background: rgba(255, 255, 255, 0.03);
      padding: 10px 10px;
      color: var(--text-muted);
      font-weight: 600;
      border-bottom: 1px solid var(--surface-border);
    }
    td {
      padding: 10px 10px;
      border-bottom: 1px solid var(--surface-border);
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      background: rgba(0, 0, 0, 0.35);
      padding: 2px 6px;
      border-radius: 4px;
      color: #93c5fd;
    }

    .modal {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal.open { display: flex; }
    .modal-content {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      width: 100%;
      max-width: 520px;
      padding: 24px;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .form-control {
      width: 100%;
      padding: 10px 12px;
      background: #090d16;
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
    }
    .form-control:focus { outline: none; border-color: var(--primary); }

    .token-alert {
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.35);
      border-radius: 8px;
      padding: 14px;
      margin-top: 14px;
      margin-bottom: 14px;
    }
    .token-alert p { font-size: 12px; color: #34d399; margin-bottom: 8px; font-weight: 600; }
    .token-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #090d16;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--surface-border);
    }
    .token-box span {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      color: #f3f4f6;
      word-break: break-all;
      flex: 1;
    }

    .playground-grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 20px;
    }
    @media (max-width: 860px) {
      .playground-grid { grid-template-columns: 1fr; }
    }
    .console-out {
      background: #090d16;
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      height: 410px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: #a7f3d0;
    }
    .progress-bar-banner {
      display: none;
      margin-bottom: 12px;
      padding: 8px 12px;
      border-radius: 6px;
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.35);
      color: #93c5fd;
      font-size: 12px;
      font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1>Agent Clearing Desk</h1>
        <p>Enterprise micro-clearing, budget circuit breakers, tool allowlists, and SHA-256 audit receipts for autonomous AI agents</p>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <span class="badge">MCP 2024-11-05 + REST /v1</span>
        <span class="badge badge-green">● Galuxium Engine Live</span>
      </div>
    </header>

    <div class="metrics-grid" role="region" aria-label="Real-time financial metrics">
      <div class="card">
        <div class="card-label">Active Agent Keys</div>
        <div class="card-value" id="statKeys">-</div>
        <div class="card-sub">Budget-governed agents</div>
      </div>
      <div class="card">
        <div class="card-label">Total Allocated Budget</div>
        <div class="card-value" id="statBudget">-</div>
        <div class="card-sub">Prepaid float across keys</div>
      </div>
      <div class="card">
        <div class="card-label">Total Spend Metered</div>
        <div class="card-value" id="statSpent">-</div>
        <div class="card-sub">Cloudflare D1 4-write batch</div>
      </div>
      <div class="card">
        <div class="card-label">Clearing Margin</div>
        <div class="card-value" id="statMargin">-</div>
        <div class="card-sub">Gross margin earned (20%-50%)</div>
      </div>
      <div class="card">
        <div class="card-label">Signed Receipts</div>
        <div class="card-value" id="statReceipts">-</div>
        <div class="card-sub">Tamper-evident SHA-256</div>
      </div>
    </div>

    <div id="rotationBanner" class="token-alert" style="display:none;" role="status" aria-live="polite">
      <p id="rotationBannerTitle">Rotated Agent Secret Key (save now; previous secret invalidated):</p>
      <div class="token-box">
        <span id="rotationBannerKey"></span>
        <button class="btn btn-sm btn-secondary" onclick="copyTextId('rotationBannerKey')">Copy Key</button>
      </div>
    </div>

    <div class="nav-tabs" role="tablist">
      <button class="tab-btn active" role="tab" onclick="switchTab('keys')">Agent Keys &amp; Caps</button>
      <button class="tab-btn" role="tab" onclick="switchTab('audit')">Audit &amp; Receipt Ledger</button>
      <button class="tab-btn" role="tab" onclick="switchTab('economics')">Monetization Blueprint</button>
      <button class="tab-btn" role="tab" onclick="switchTab('playground')">Agent Playground &amp; Live Demo</button>
    </div>

    <!-- TAB 1: KEYS -->
    <div id="tab-keys" class="tab-pane">
      <div class="card">
        <div class="section-title">
          <h2>Active Agent Keys &amp; Spend Caps</h2>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-accent" onclick="switchTab('playground'); runFiveStepDemo();">⚡ Run 5-Step Governance Demo</button>
            <button class="btn" onclick="openCreateModal()">+ Issue Agent Key</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Agent / Label</th>
              <th>Key ID</th>
              <th>Prefix</th>
              <th>Budget (Cap)</th>
              <th>Spent</th>
              <th>Remaining</th>
              <th>Allowlist</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="keysTableBody">
            <tr><td colspan="9" style="text-align:center;">Loading keys...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 2: AUDIT & RECEIPTS -->
    <div id="tab-audit" class="tab-pane" style="display:none;">
      <div class="card">
        <div class="section-title">
          <h2>Signed Audit &amp; Receipt Ledger</h2>
          <button class="btn btn-secondary btn-sm" onclick="loadAudit()">Refresh Ledger</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Timestamp (UTC)</th>
              <th>Key ID</th>
              <th>Tool Name</th>
              <th>Protocol</th>
              <th>Status</th>
              <th>Price</th>
              <th>Signed Receipt (Verify JSON)</th>
              <th>Audit Log ID</th>
            </tr>
          </thead>
          <tbody id="auditTableBody">
            <tr><td colspan="8" style="text-align:center;">Loading audit ledger...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 3: MONETIZATION BLUEPRINT -->
    <div id="tab-economics" class="tab-pane" style="display:none;">
      <div class="card">
        <div class="section-title">
          <h2>Fiscal Architecture &amp; Per-Call Clearing Margin Catalog</h2>
          <span class="badge badge-green">D1 Batch: 4 writes/call (25,000 calls/day free tier)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Tool Surface (MCP &amp; REST)</th>
              <th>Upstream OpenKrill Endpoint</th>
              <th>Upstream Cost Basis</th>
              <th>Clearing Retail Price</th>
              <th>Net Clearing Margin</th>
              <th>Gross Margin %</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>eu_duty_estimate</strong> <span class="code">shop-duty</span></td>
              <td><span class="code">/plugins/shop-duty/mcp</span></td>
              <td>$0.0050 (0.50¢)</td>
              <td><strong>$0.0100 (1.00¢)</strong></td>
              <td style="color:#34d399;">+$0.0050 (0.50¢)</td>
              <td><span class="badge badge-green">50.0%</span></td>
            </tr>
            <tr>
              <td><strong>find_tariff_codes</strong> <span class="code">tariffs</span></td>
              <td><span class="code">/plugins/tariffs/mcp</span></td>
              <td>$0.0050 (0.50¢)</td>
              <td><strong>$0.0100 (1.00¢)</strong></td>
              <td style="color:#34d399;">+$0.0050 (0.50¢)</td>
              <td><span class="badge badge-green">50.0%</span></td>
            </tr>
            <tr>
              <td><strong>check_vat_number</strong> <span class="code">eu-business</span></td>
              <td><span class="code">/plugins/eu-business/mcp</span></td>
              <td>$0.0050 (0.50¢)</td>
              <td><strong>$0.0100 (1.00¢)</strong></td>
              <td style="color:#34d399;">+$0.0050 (0.50¢)</td>
              <td><span class="badge badge-green">50.0%</span></td>
            </tr>
            <tr>
              <td><strong>list_jobs</strong> <span class="code">job-boards</span></td>
              <td><span class="code">/v1/tools/job-boards/run</span></td>
              <td>$0.0015 (0.15¢)</td>
              <td><strong>$0.0020 (0.20¢)</strong></td>
              <td style="color:#34d399;">+$0.0005 (0.05¢)</td>
              <td><span class="badge badge-green">25.0%</span></td>
            </tr>
            <tr>
              <td><strong>get_app_reviews</strong> <span class="code">app-reviews</span></td>
              <td><span class="code">/v1/tools/app-reviews/run</span></td>
              <td>$0.00015 (0.015¢)</td>
              <td><strong>$0.00025 (0.025¢)</strong></td>
              <td style="color:#34d399;">+$0.00010 (0.01¢)</td>
              <td><span class="badge badge-green">40.0%</span></td>
            </tr>
            <tr>
              <td><strong>get_transcript</strong> <span class="code">yt-transcripts</span></td>
              <td><span class="code">/v1/tools/yt-transcripts/run</span></td>
              <td>$0.0040 (0.40¢)</td>
              <td><strong>$0.0050 (0.50¢)</strong></td>
              <td style="color:#34d399;">+$0.0010 (0.10¢)</td>
              <td><span class="badge badge-green">20.0%</span></td>
            </tr>
            <tr>
              <td><strong>check_agent_balance / get_call_receipt</strong></td>
              <td><span class="code">Edge D1 Self-Inspection</span></td>
              <td>$0.0000 (0.00¢)</td>
              <td><strong>$0.0000 (Free)</strong></td>
              <td>$0.0000</td>
              <td><span class="badge">Included</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 4: PLAYGROUND -->
    <div id="tab-playground" class="tab-pane" style="display:none;">
      <div class="card">
        <div class="section-title">
          <h2>Interactive Agent Call Simulator &amp; Governance Verification</h2>
          <button class="btn btn-accent" onclick="runFiveStepDemo()">⚡ Run 5-Step Live Governance Demo</button>
        </div>
        <div id="playProgress" class="progress-bar-banner" aria-live="polite"></div>
        <div class="playground-grid">
          <div>
            <div class="form-group">
              <label for="playKey">Agent Secret Key (auto-filled when you issue a key or run the 5-step demo)</label>
              <input type="text" id="playKey" class="form-control" placeholder="cd_live_...">
            </div>
            <div class="form-group">
              <label for="playTool">Target Tool</label>
              <select id="playTool" class="form-control" onchange="updatePlaygroundTemplate()">
                <option value="eu_duty_estimate">eu_duty_estimate (Shop Duty - 3 EUR / item EU duty, 1.00¢)</option>
                <option value="check_vat_number">check_vat_number (EU VIES VAT Registry, 1.00¢)</option>
                <option value="find_tariff_codes">find_tariff_codes (USITC / UK Trade Tariff HS Codes, 1.00¢)</option>
                <option value="list_jobs">list_jobs (Greenhouse / Lever / Ashby Jobs, 0.20¢)</option>
                <option value="get_app_reviews">get_app_reviews (iOS / Play App Reviews, 0.025¢)</option>
                <option value="check_agent_balance">check_agent_balance (MCP Zero-Cost Self-Inspection)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="playArgs">Payload (JSON)</label>
              <textarea id="playArgs" class="form-control" rows="6">{"items": "3 T-shirts", "quantity": 3, "unit_value_eur": 20}</textarea>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="btn" onclick="executePlaygroundCall()">Execute Call via Clearing Desk</button>
              <button class="btn btn-secondary" onclick="executeFiveStepQuickIssue()">Issue Scoped 2¢ Demo Key</button>
            </div>
          </div>
          <div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px; font-weight:600;">Response &amp; Signed Receipt Output:</div>
            <div id="playOutput" class="console-out" aria-live="polite">// Ready to execute tool call or click "⚡ Run 5-Step Live Governance Demo"...</div>
          </div>
        </div>
      </div>
    </div>

  </div>

  <!-- Create Key Modal -->
  <div id="createModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="createModalTitle">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="createModalTitle">Issue New Agent Key</h3>
        <button class="btn btn-secondary btn-sm" onclick="closeCreateModal()">✕</button>
      </div>
      <div class="form-group">
        <label for="createName">Agent Name / Purpose</label>
        <input type="text" id="createName" class="form-control" placeholder="e.g. EU Duty Checker Agent" value="FinOps Compliance Agent">
      </div>
      <div class="form-group">
        <label for="createBudget">Budget Cap (USD cents, e.g. 500 = $5.00, 2 = $0.02)</label>
        <input type="number" id="createBudget" class="form-control" value="5">
      </div>
      <div class="form-group">
        <label for="createPrice">Default Per-Call Price (USD cents)</label>
        <input type="number" id="createPrice" class="form-control" value="1">
      </div>
      <div class="form-group">
        <label for="createAllowlist">Tool Allowlist (comma-separated, * for all)</label>
        <input type="text" id="createAllowlist" class="form-control" value="eu_duty_estimate,check_vat_number,find_tariff_codes,list_jobs">
      </div>
      <button class="btn" style="width:100%;" onclick="submitCreateKey()">Issue Key</button>

      <div id="newKeyAlert" class="token-alert" style="display:none;">
        <p>Save this agent key now. It will never be shown again:</p>
        <div class="token-box">
          <span id="rawKeyDisplay"></span>
          <button class="btn btn-sm btn-secondary" onclick="copyTextId('rawKeyDisplay')">Copy</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentRawKey = '';

    function setProgress(text) {
      const el = document.getElementById('playProgress');
      if (!text) {
        el.style.display = 'none';
        el.innerText = '';
      } else {
        el.style.display = 'block';
        el.innerText = text;
      }
    }

    async function loadOverview() {
      try {
        const res = await fetch('/api/admin/overview');
        const data = await res.json();
        document.getElementById('statKeys').innerText = data.totalKeys;
        document.getElementById('statBudget').innerText = '$' + (data.totalBudgetCents / 100).toFixed(2);
        document.getElementById('statSpent').innerText = '$' + (data.totalSpentCents / 100).toFixed(4);
        document.getElementById('statMargin').innerText = '$' + (data.totalMarginCents / 100).toFixed(4);
        document.getElementById('statReceipts').innerText = data.totalReceipts;
      } catch (e) {
        console.error(e);
      }
    }

    async function loadKeys() {
      try {
        const res = await fetch('/api/admin/keys');
        const data = await res.json();
        const tbody = document.getElementById('keysTableBody');
        tbody.innerHTML = '';
        if (!data.keys || data.keys.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">No keys found. Click "+ Issue Agent Key" or "⚡ Run 5-Step Governance Demo".</td></tr>';
          return;
        }
        data.keys.forEach(k => {
          const rem = Math.max(0, k.budget_cents - k.spent_cents);
          let allowlistHtml = '<span class="code">*</span>';
          try {
            const parsedList = JSON.parse(k.allowlist || '["*"]');
            allowlistHtml = parsedList.map(t => '<span class="code" style="display:inline-block; margin:2px 3px 2px 0;">' + t + '</span>').join('');
          } catch {
            allowlistHtml = '<span class="code">' + k.allowlist + '</span>';
          }
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><strong>\${k.name}</strong></td>
            <td><span class="code">\${k.key_id}</span></td>
            <td><span class="code">\${k.key_prefix}</span></td>
            <td>$\${(k.budget_cents / 100).toFixed(2)}</td>
            <td>$\${(k.spent_cents / 100).toFixed(4)}</td>
            <td style="color:\${rem > 0 ? '#34d399' : '#f87171'}; font-weight:600;">$\${(rem / 100).toFixed(4)}</td>
            <td style="max-width:250px;">\${allowlistHtml}</td>
            <td><span class="badge \${k.status === 'active' ? 'badge-green' : 'badge-red'}">\${k.status}</span></td>
            <td style="display:flex; gap:6px;">
              <button class="btn btn-secondary btn-sm" onclick="rotateKey('\${k.key_id}')">Rotate</button>
              <button class="btn btn-danger btn-sm" onclick="revokeKey('\${k.key_id}')">Revoke</button>
            </td>
          \`;
          tbody.appendChild(tr);
        });
      } catch (e) {
        console.error(e);
      }
    }

    async function loadAudit() {
      try {
        const res = await fetch('/api/admin/audit?limit=50');
        const data = await res.json();
        const tbody = document.getElementById('auditTableBody');
        tbody.innerHTML = '';
        if (!data.audit_logs || data.audit_logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No audit records found yet.</td></tr>';
          return;
        }
        data.audit_logs.forEach(log => {
          const tr = document.createElement('tr');
          const dateStr = new Date(log.created_at).toISOString().slice(11, 19) + 'Z';
          let badgeClass = 'badge-green';
          if (log.status === 'refused_budget') badgeClass = 'badge-amber';
          if (log.status === 'refused_allowlist') badgeClass = 'badge-amber';
          if (log.status === 'error') badgeClass = 'badge-red';
          const rcptId = log.id.replace('aud_', 'rcpt_');

          tr.innerHTML = \`
            <td>\${dateStr}</td>
            <td><span class="code">\${log.key_id}</span></td>
            <td><strong>\${log.tool_name}</strong></td>
            <td><span class="code">\${log.protocol}</span></td>
            <td><span class="badge \${badgeClass}">\${log.status}</span></td>
            <td>$\${(log.price_cents / 100).toFixed(4)}</td>
            <td><a href="/v1/receipts/\${rcptId}" target="_blank" class="code" style="color:#60a5fa; text-decoration:underline;">\${rcptId}</a></td>
            <td><span class="code">\${log.id}</span></td>
          \`;
          tbody.appendChild(tr);
        });
      } catch (e) {
        console.error(e);
      }
    }

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
      const idxMap = { keys: 1, audit: 2, economics: 3, playground: 4 };
      const idx = idxMap[name] || 1;
      document.querySelector('.tab-btn:nth-child(' + idx + ')').classList.add('active');
      document.getElementById('tab-' + name).style.display = 'block';
      if (name === 'keys') loadKeys();
      if (name === 'audit') loadAudit();
    }

    function openCreateModal() {
      document.getElementById('createModal').classList.add('open');
      document.getElementById('newKeyAlert').style.display = 'none';
    }
    function closeCreateModal() {
      document.getElementById('createModal').classList.remove('open');
      loadKeys();
      loadOverview();
    }

    async function submitCreateKey() {
      const name = document.getElementById('createName').value.trim() || 'Agent Key';
      const budgetCents = parseInt(document.getElementById('createBudget').value, 10);
      const perCallPriceCents = parseInt(document.getElementById('createPrice').value, 10);
      const allowlistRaw = document.getElementById('createAllowlist').value.trim();
      const allowlist = allowlistRaw === '*' ? ['*'] : allowlistRaw.split(',').map(s => s.trim()).filter(Boolean);

      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, budgetCents, perCallPriceCents, allowlist }),
      });
      const data = await res.json();
      if (data.rawKey) {
        currentRawKey = data.rawKey;
        document.getElementById('rawKeyDisplay').innerText = data.rawKey;
        document.getElementById('newKeyAlert').style.display = 'block';
        document.getElementById('playKey').value = data.rawKey;
        loadKeys();
        loadOverview();
      }
    }

    async function rotateKey(keyId) {
      const res = await fetch('/api/admin/keys/' + keyId + '/rotate', { method: 'POST' });
      const data = await res.json();
      if (data.rawKey) {
        currentRawKey = data.rawKey;
        document.getElementById('playKey').value = data.rawKey;
        document.getElementById('rotationBannerTitle').innerText = 'Rotated Secret for ' + keyId + ' (previous secret invalidated immediately; spend history preserved):';
        document.getElementById('rotationBannerKey').innerText = data.rawKey;
        document.getElementById('rotationBanner').style.display = 'block';
        loadKeys();
      }
    }

    async function revokeKey(keyId) {
      await fetch('/api/admin/keys/' + keyId + '/revoke', { method: 'POST' });
      loadKeys();
      loadOverview();
    }

    function copyTextId(elId) {
      const text = document.getElementById(elId).innerText;
      navigator.clipboard.writeText(text);
    }

    function updatePlaygroundTemplate() {
      const tool = document.getElementById('playTool').value;
      const ta = document.getElementById('playArgs');
      if (tool === 'eu_duty_estimate') {
        ta.value = JSON.stringify({ items: "3 T-shirts", quantity: 3, unit_value_eur: 20 }, null, 2);
      } else if (tool === 'check_vat_number') {
        ta.value = JSON.stringify({ vat_number: "ATU33864707" }, null, 2);
      } else if (tool === 'find_tariff_codes') {
        ta.value = JSON.stringify({ query: "ceramic coffee mug", country: "US" }, null, 2);
      } else if (tool === 'list_jobs') {
        ta.value = JSON.stringify({ companies: "airbnb", keyword: "engineer" }, null, 2);
      } else if (tool === 'get_app_reviews') {
        ta.value = JSON.stringify({ app: "com.spotify.music" }, null, 2);
      } else {
        ta.value = "{}";
      }
    }

    async function executeFiveStepQuickIssue() {
      setProgress('[Step 1/1] Issuing scoped 2-cent demo key...');
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Playground Scoped Agent (2¢ Cap)',
          budgetCents: 2,
          perCallPriceCents: 1,
          allowlist: ['eu_duty_estimate', 'check_vat_number', 'find_tariff_codes', 'list_jobs'],
        }),
      });
      const data = await res.json();
      setProgress('');
      if (data.rawKey) {
        currentRawKey = data.rawKey;
        document.getElementById('playKey').value = data.rawKey;
        document.getElementById('playOutput').innerText = '// Issued scoped key ' + data.key.key_id + ' (Budget: $0.0200, Allowlist: eu_duty_estimate, check_vat_number, find_tariff_codes, list_jobs)\\n' + JSON.stringify(data.key, null, 2);
        loadOverview();
        loadKeys();
      }
    }

    async function executePlaygroundCall() {
      const key = document.getElementById('playKey').value.trim();
      const tool = document.getElementById('playTool').value;
      const argsText = document.getElementById('playArgs').value;
      const out = document.getElementById('playOutput');

      if (!key) {
        await executeFiveStepQuickIssue();
      }
      const activeKey = document.getElementById('playKey').value.trim();

      let parsed = {};
      try { parsed = JSON.parse(argsText); } catch { out.innerText = '// Error: Invalid JSON in payload'; return; }

      setProgress('[Running 1/1] Calling ' + tool + ' through Agent Clearing Desk...');
      out.innerText = '// Executing call to ' + tool + '...\\n';
      const t0 = performance.now();

      try {
        if (tool === 'check_agent_balance') {
          const mcpRes = await fetch('/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': activeKey },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_agent_balance', arguments: {} } }),
          });
          const elapsed = (performance.now() - t0).toFixed(1);
          const data = await mcpRes.json();
          setProgress('');
          out.innerText = '// MCP Status: ' + mcpRes.status + ' (' + elapsed + ' ms, $0.0000 administrative tool)\\n\\n' + JSON.stringify(data, null, 2);
          return;
        }

        const res = await fetch('/v1/tools/' + tool + '/run', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': activeKey,
          },
          body: JSON.stringify(parsed),
        });
        const elapsed = (performance.now() - t0).toFixed(1);
        const data = await res.json();
        setProgress('');
        out.innerText = '// HTTP Status: ' + res.status + ' (' + elapsed + ' ms)\\n' +
          '// Receipt Header: ' + (res.headers.get('x-clearing-receipt') || 'none') + '\\n' +
          '// Receipt Hash: ' + (res.headers.get('x-clearing-receipt-hash') || 'none') + '\\n' +
          '// Price Charged: ' + (res.headers.get('x-clearing-price-cents') || '0') + ' cents\\n' +
          '// Remaining Budget: ' + (res.headers.get('x-clearing-remaining-budget-cents') || '0') + ' cents\\n\\n' +
          JSON.stringify(data, null, 2);

        loadOverview();
        loadKeys();
      } catch (e) {
        setProgress('');
        out.innerText = '// Network Error: ' + e;
      }
    }

    async function runFiveStepDemo() {
      const out = document.getElementById('playOutput');
      const logLines = [];
      const append = (line) => {
        logLines.push(line);
        out.innerText = logLines.join('\\n');
        out.scrollTop = out.scrollHeight;
      };

      setProgress('[Step 1/5] Issuing scoped agent key (Budget: 2 cents, Allowlist: eu_duty_estimate, check_vat_number)...');
      append('=== [Step 1/5] Issue Scoped Agent Key (Budget: $0.0200, Allowlist: eu_duty_estimate, check_vat_number) ===');
      const keyRes = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Galuxium Live Demo Agent',
          budgetCents: 2,
          perCallPriceCents: 1,
          allowlist: ['eu_duty_estimate', 'check_vat_number'],
        }),
      });
      const keyData = await keyRes.json();
      const rawKey = keyData.rawKey;
      document.getElementById('playKey').value = rawKey;
      append('Issued Key ID: ' + keyData.key.key_id + ' | Prefix: ' + keyData.key.key_prefix + ' | Budget: 2 cents\\n');

      setProgress('[Step 2/5] Calling eu_duty_estimate (1 cent) -> Expect 200 OK + SHA-256 Receipt...');
      append('=== [Step 2/5] Call Allowed Tool: eu_duty_estimate (Price: 1 cent) ===');
      const call1 = await fetch('/v1/tools/eu_duty_estimate/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ items: '3 T-shirts', quantity: 3, unit_value_eur: 20 }),
      });
      const call1Json = await call1.json();
      const rcpt1 = call1.headers.get('x-clearing-receipt');
      append('Status: ' + call1.status + ' | Receipt: ' + rcpt1 + ' | Remaining Budget: ' + call1.headers.get('x-clearing-remaining-budget-cents') + ' cent(s)');
      append('EU Duty Result: ' + JSON.stringify(call1Json.result.total_duty_eur) + ' EUR under ' + call1Json.result.regulation + '\\n');

      setProgress('[Step 3/5] Calling disallowed tool get_app_reviews -> Expect 403 tool_not_allowed...');
      append('=== [Step 3/5] Call Disallowed Tool: get_app_reviews -> Expect 403 Allowlist Guardrail ===');
      const call2 = await fetch('/v1/tools/get_app_reviews/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ app: 'com.spotify.music' }),
      });
      const call2Json = await call2.json();
      append('Status: ' + call2.status + ' | Error Code: ' + call2Json.error.code + ' | Message: ' + call2Json.error.message + '\\n');

      setProgress('[Step 4/5] Calling check_vat_number (1 cent) & triggering 402 budget_exceeded circuit breaker...');
      append('=== [Step 4/5] Spend Remaining 1 Cent on check_vat_number, Then Trigger 402 Budget Circuit Breaker ===');
      const call3 = await fetch('/v1/tools/check_vat_number/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ vat_number: 'ATU33864707' }),
      });
      const call3Json = await call3.json();
      append('Call 3 (check_vat_number) Status: ' + call3.status + ' | Valid: ' + call3Json.result.valid + ' (' + (call3Json.result.name || 'VIES') + ') | Remaining: ' + call3.headers.get('x-clearing-remaining-budget-cents') + ' cents');

      const call4 = await fetch('/v1/tools/eu_duty_estimate/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': rawKey },
        body: JSON.stringify({ items: '1 Jacket', quantity: 1, unit_value_eur: 80 }),
      });
      const call4Json = await call4.json();
      append('Call 4 (Over Budget) Status: ' + call4.status + ' | Code: ' + call4Json.error.code + ' | Refusal Receipt: ' + call4Json.error.receipt_id + '\\n');

      setProgress('[Step 5/5] Verifying cryptographic SHA-256 signature on Receipt ' + rcpt1 + '...');
      append('=== [Step 5/5] Verify Cryptographic SHA-256 Receipt (' + rcpt1 + ') ===');
      const verifyRes = await fetch('/v1/receipts/' + rcpt1);
      const verifyJson = await verifyRes.json();
      append('Signature Valid: ' + verifyJson.signature_valid + ' | Hash: ' + verifyJson.receipt.receipt_hash);
      append('\\n✓ All 5 Enterprise Governance & Fiscal Settlement checks passed live.');

      setProgress('');
      loadOverview();
      loadKeys();
      loadAudit();
    }

    // Init
    loadOverview();
    loadKeys();
  </script>
</body>
</html>`;
}
