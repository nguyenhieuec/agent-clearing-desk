# Judge Verification Guide - Agent Clearing Desk (Galuxium Nexus V2)

Every surface of Agent Clearing Desk is deployed live on Cloudflare Workers and D1.
Judges can verify the entire governance, metering, policy-refusal, budget circuit-breaker, and cryptographic receipt workflow in under 90 seconds without installing anything.

## 1. Live Production Endpoints

- **FinOps Control Plane & Interactive 5-Step Demo UI**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/admin`
- **Health Probe**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/health`
- **HTTP Tool Proxy Catalog**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/tools`
- **MCP Server (JSON-RPC 2.0)**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp`
- **Pitch & Live Demo Video (`2m 36s`)**: `https://youtu.be/ghDr76m1lsQ`
- **Source Code Repository**: `https://github.com/nguyenhieuec/agent-clearing-desk`

## 2. Option A: One-Click Browser Verification (30 Seconds)

1. Open `https://agent-clearing-desk.nguyenhieuec.workers.dev/admin` in any browser.
2. Click the fourth tab, **Agent Playground (5-Step Live Demo)**, or click the emerald **Run 5-Step Live Governance Demo** button in the top header.
3. Watch the live execution log run five sequential governance checks against the production Cloudflare Worker and D1 database:
   - `[Step 1/5]` Issues a fresh scoped agent key (`cd_live_...`) with a 10-cent hard spending cap and a 2-tool allowlist (`eu_duty_estimate`, `list_jobs`).
   - `[Step 2/5]` Executes a live `eu_duty_estimate` call (`200 OK`), deducts 1 cent, and returns a signed SHA-256 receipt (`rcpt_...`).
   - `[Step 3/5]` Attempts an unauthorized `get_app_reviews` call (`403 Forbidden - tool_not_allowed`) with `$0.00` charged.
   - `[Step 4/5]` Exhausts the remaining budget and triggers the pre-flight circuit breaker (`402 Payment Required - budget_exceeded`), issuing a signed refusal receipt.
   - `[Step 5/5]` Verifies the cryptographic signature (`signature_valid: true`) on `/v1/receipts/:id`.
4. Switch to the **Audit & Receipt Ledger** tab and click any `rcpt_...` badge to inspect the raw JSON receipt and its SHA-256 signature verification.
5. Switch to the **Monetization Blueprint** tab to inspect the wholesale cost, retail price, and clearing spread per tool call.

## 3. Option B: Copy-Paste Terminal Verification (`curl`)

Run the following commands in any terminal to mint your own scoped agent key, run a live tool call, trigger both guardrails, and verify the signed receipt:

```bash
# 1. Mint a scoped agent key with a 3-cent cap and allowlist ["eu_duty_estimate"]
KEY_JSON=$(curl -sS -X POST https://agent-clearing-desk.nguyenhieuec.workers.dev/api/admin/keys \
  -H "Content-Type: application/json" \
  -d '{"name":"judge-verification-agent","budgetCents":3,"allowlist":["eu_duty_estimate"],"perCallPriceCents":2}')
echo "$KEY_JSON" | jq .

RAW_KEY=$(echo "$KEY_JSON" | jq -r '.rawKey')

# 2. Execute a live governed tool call (HTTP 200 OK, charges 1 cent catalog rate, issues rcpt_*)
RUN_RES=$(curl -sS -X POST https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/tools/eu_duty_estimate/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RAW_KEY" \
  -d '{"items":"3 Cotton T-shirts","quantity":3,"unit_value_eur":25}')
echo "$RUN_RES" | jq .

RECEIPT_ID=$(echo "$RUN_RES" | jq -r '.clearing_receipt.receipt_id')

# 3. Verify the cryptographic receipt signature (HTTP 200 OK, signature_valid: true)
curl -sS "https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/receipts/$RECEIPT_ID" | jq .

# 4. Trigger the allowlist guardrail (HTTP 403 tool_not_allowed, $0.00 charged)
curl -sS -X POST https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/tools/find_tariff_codes/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RAW_KEY" \
  -d '{"query":"ceramic mug"}' | jq .

# 5. Inspect real-time metered usage and upstream OpenKrill telemetry
curl -sS https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/usage \
  -H "x-api-key: $RAW_KEY" | jq .
```

## 4. Option C: Local & End-to-End Automated Test Suite

```bash
git clone https://github.com/nguyenhieuec/agent-clearing-desk.git
cd agent-clearing-desk
npm install
npm test
npm run typecheck
npm run e2e
```

The `npm run e2e` script runs 12 live assertions against `https://agent-clearing-desk.nguyenhieuec.workers.dev` and writes the full verification log to `submission/galuxium/e2e-live-output.json`.
