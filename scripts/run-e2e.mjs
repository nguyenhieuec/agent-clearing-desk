#!/usr/bin/env node
/**
 * End-to-End Live Verification Suite for Agent Clearing Desk (Galuxium Nexus V2)
 * Executes real governed tool calls, allowlist refusal, budget circuit-breaker refusal,
 * key rotation, receipt verification, MCP protocol flow, and upstream OpenKrill usage check
 * against the live Cloudflare Worker + D1 deployment.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.CLEARING_DESK_URL || "https://agent-clearing-desk.nguyenhieuec.workers.dev";

function buildCurlArgs(urlPath, method, headers, body) {
  const args = ["-sS", "-w", "\n__HTTP_STATUS__:%{http_code}", "-X", method, `${BASE_URL}${urlPath}`];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (body !== undefined) {
    args.push("-d", typeof body === "string" ? body : JSON.stringify(body));
  }
  return args;
}

function parseCurlResponse(rawOut, latencyMs) {
  const splitIdx = rawOut.lastIndexOf("\n__HTTP_STATUS__:");
  const text = splitIdx >= 0 ? rawOut.slice(0, splitIdx) : rawOut;
  const status = splitIdx >= 0 ? Number(rawOut.slice(splitIdx + 17).trim()) : 0;
  try {
    return { status, latencyMs, body: JSON.parse(text) };
  } catch {
    return { status, latencyMs, body: { raw: text } };
  }
}

function requestJson(urlPath, { method = "GET", headers = {}, body } = {}) {
  const start = Date.now();
  const args = buildCurlArgs(urlPath, method, headers, body);
  const rawOut = execFileSync("curl", args, { encoding: "utf8" });
  return parseCurlResponse(rawOut, Date.now() - start);
}

function assert(condition, message, context = {}) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message} - ${JSON.stringify(context)}`);
  }
}

function verifyHealth(steps) {
  const health = requestJson("/health");
  assert(health.status === 200 && health.body.status === "ok", "Health check must return 200 ok", health);
  steps.push({ step: "1_health_check", status: health.status, latencyMs: health.latencyMs, response: health.body });
}

function mintScopedKey(steps) {
  const createKey = requestJson("/api/admin/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      name: "galuxium-e2e-procurement-agent",
      budgetCents: 10,
      perCallPriceCents: 2,
      toolPricingOverrides: {
        eu_duty_estimate: 2,
        find_tariff_codes: 2,
        check_vat_number: 2,
        list_jobs: 2,
        get_app_reviews: 2
      },
      allowlist: ["eu_duty_estimate", "find_tariff_codes", "check_vat_number", "list_jobs", "get_app_reviews"]
    }
  });
  const ok = createKey.status === 201 && String(createKey.body.rawKey).startsWith("cd_live_");
  assert(ok, "Must mint cd_live_ key", createKey);
  steps.push({
    step: "2_mint_scoped_key",
    status: createKey.status,
    latencyMs: createKey.latencyMs,
    keyId: createKey.body.key.key_id,
    keyPrefix: createKey.body.key.key_prefix,
    budgetCents: createKey.body.key.budget_cents,
    perCallPriceCents: createKey.body.key.per_call_price_cents,
    allowlist: JSON.parse(createKey.body.key.allowlist)
  });
  return { rawKey: createKey.body.rawKey, keyId: createKey.body.key.key_id };
}

function runLiveToolStep(steps, stepLabel, toolName, authHeaders, payload) {
  const res = requestJson(`/v1/tools/${toolName}/run`, {
    method: "POST",
    headers: authHeaders,
    body: payload
  });
  const hasReceipt = Boolean(res.body.clearing_receipt && res.body.clearing_receipt.receipt_id);
  const isLive = Boolean(res.body.result && res.body.result.upstream_live === true);
  assert(res.status === 200 && hasReceipt && isLive, `${toolName} must return 200 live with receipt`, res);
  steps.push({
    step: stepLabel,
    status: res.status,
    latencyMs: res.latencyMs,
    clearingReceipt: res.body.clearing_receipt,
    upstreamLive: res.body.result.upstream_live,
    upstreamEndpoint: res.body.result.upstream_endpoint
  });
  return res.body.clearing_receipt.receipt_id;
}

function verifyGuardrails(steps, authHeaders) {
  const blockedTool = requestJson("/v1/tools/unauthorized_wire_transfer/run", {
    method: "POST",
    headers: authHeaders,
    body: { amount_usd: 25000, beneficiary: "offshore-acct" }
  });
  const is403 = blockedTool.status === 403 && blockedTool.body.error.code === "tool_not_allowed";
  assert(is403, "Disallowed tool must return 403 tool_not_allowed", blockedTool);
  steps.push({
    step: "8_policy_refusal_allowlist_403",
    status: blockedTool.status,
    latencyMs: blockedTool.latencyMs,
    response: blockedTool.body
  });

  const overBudget = requestJson("/v1/tools/eu_duty_estimate/run", {
    method: "POST",
    headers: authHeaders,
    body: { items: "5 Wool Coats", quantity: 5, unit_value_eur: 28 }
  });
  const is402 = overBudget.status === 402 && overBudget.body.error.code === "budget_exceeded";
  assert(is402, "Over-budget call must return 402 budget_exceeded", overBudget);
  steps.push({
    step: "9_budget_circuit_breaker_402",
    status: overBudget.status,
    latencyMs: overBudget.latencyMs,
    response: overBudget.body
  });
}

function verifyReceiptAndMcp(steps, authHeaders, firstReceiptId) {
  const receiptCheck = requestJson(`/v1/receipts/${firstReceiptId}`);
  assert(receiptCheck.status === 200 && receiptCheck.body.signature_valid === true, "Receipt must verify", receiptCheck);
  steps.push({
    step: "10_verify_signed_receipt",
    status: receiptCheck.status,
    latencyMs: receiptCheck.latencyMs,
    receiptId: receiptCheck.body.receipt.id,
    signatureValid: receiptCheck.body.signature_valid,
    receiptHashPrefix: receiptCheck.body.receipt.receipt_hash.slice(0, 24)
  });

  const mcpInit = requestJson("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: { jsonrpc: "2.0", id: 1, method: "initialize" }
  });
  assert(mcpInit.status === 200, "MCP initialize must succeed", mcpInit);

  const mcpBalance = requestJson("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_agent_balance", arguments: {} } }
  });
  const bal = mcpBalance.body.result.structuredContent;
  assert(bal.spent_cents === 10 && bal.remaining_cents === 0, "MCP balance must reflect 10 cents spent", bal);

  const mcpReceipt = requestJson("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_call_receipt", arguments: { receipt_id: firstReceiptId } } }
  });
  assert(mcpReceipt.body.result.structuredContent.signature_valid === true, "MCP receipt must verify", mcpReceipt);

  steps.push({
    step: "11_mcp_protocol_flow",
    status: mcpBalance.status,
    latencyMs: mcpBalance.latencyMs,
    mcpServer: mcpInit.body.result.serverInfo,
    agentBalance: bal,
    mcpReceiptVerified: mcpReceipt.body.result.structuredContent.signature_valid
  });
}

function verifyRotationAndUsage(steps, keyId, rawKey) {
  const rotateRes = requestJson(`/api/admin/keys/${keyId}/rotate`, { method: "POST" });
  assert(rotateRes.status === 200 && String(rotateRes.body.rawKey).startsWith("cd_live_"), "Rotation must succeed", rotateRes);
  const rotatedKey = rotateRes.body.rawKey;

  const oldKeyCall = requestJson("/v1/usage", { headers: { "x-api-key": rawKey } });
  assert(oldKeyCall.status === 401, "Old rotated key must be rejected with 401", oldKeyCall);

  const newKeyUsage = requestJson("/v1/usage", { headers: { "x-api-key": rotatedKey } });
  assert(newKeyUsage.status === 200 && newKeyUsage.body.spent_cents === 10, "Rotated key preserves spend", newKeyUsage);
  assert(newKeyUsage.body.upstream_openkrill_usage !== undefined, "Must include upstream OpenKrill metering", newKeyUsage);

  steps.push({
    step: "12_key_rotation_and_usage_audit",
    oldKeyStatus: oldKeyCall.status,
    newKeyStatus: newKeyUsage.status,
    spentCents: newKeyUsage.body.spent_cents,
    remainingBudgetCents: newKeyUsage.body.remaining_budget_cents,
    toolUsageBreakdown: newKeyUsage.body.usage,
    upstreamOpenkrillUsage: newKeyUsage.body.upstream_openkrill_usage
  });
}

function runLiveE2E() {
  const steps = [];
  verifyHealth(steps);
  const { rawKey, keyId } = mintScopedKey(steps);
  const authHeaders = { "Content-Type": "application/json", "x-api-key": rawKey };

  const firstReceiptId = runLiveToolStep(steps, "3_live_tool_eu_duty_estimate", "eu_duty_estimate", authHeaders, {
    items: "3 Cotton T-shirts",
    quantity: 3,
    unit_value_eur: 25
  });
  runLiveToolStep(steps, "4_live_tool_find_tariff_codes", "find_tariff_codes", authHeaders, { query: "ceramic mug" });
  runLiveToolStep(steps, "5_live_tool_check_vat_number", "check_vat_number", authHeaders, { vat_number: "ATU33864707" });
  runLiveToolStep(steps, "6_live_tool_list_jobs", "list_jobs", authHeaders, { companies: "airbnb", keyword: "engineer" });
  runLiveToolStep(steps, "7_live_tool_get_app_reviews", "get_app_reviews", authHeaders, { app: "com.spotify.music", countries: "us" });

  verifyGuardrails(steps, authHeaders);
  verifyReceiptAndMcp(steps, authHeaders, firstReceiptId);
  verifyRotationAndUsage(steps, keyId, rawKey);

  const overview = requestJson("/api/admin/overview");
  assert(overview.status === 200 && overview.body.totalReceipts >= 6, "Overview must record receipts", overview);

  const report = {
    suite: "agent-clearing-desk-live-e2e",
    hackathon: "Galuxium Nexus V2",
    workerUrl: BASE_URL,
    openkrillConnectKeyId: "05edfbb73f482e29",
    executedAt: new Date().toISOString(),
    steps,
    summary: {
      allAssertionsPassed: true,
      totalStepsVerified: steps.length,
      deskOverview: overview.body
    }
  };

  const outPaths = [
    path.resolve(process.cwd(), "submission/galuxium/e2e-live-output.json"),
    ...(process.env.E2E_EXTRA_OUT ? [process.env.E2E_EXTRA_OUT] : [])
  ];
  for (const outPath of outPaths) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(`Live E2E passed (${steps.length} steps). Output saved to:\n- ${outPaths.join("\n- ")}`);
}

runLiveE2E();
