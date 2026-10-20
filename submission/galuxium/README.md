# Agent Clearing Desk - Galuxium Nexus V2 Submission

**Agent Clearing Desk** is an edge FinOps control plane, policy firewall, and cryptographic settlement proxy for autonomous AI agents.
It sits between AI agents (`MCP JSON-RPC 2.0` or `HTTP REST /v1/*`) and paid external APIs, enforcing per-agent cent-level spending caps, strict tool allowlists, instant key rotation, and HMAC-SHA256 signed audit receipts on Cloudflare Workers and D1.

## Live Production Links

- **Live FinOps Dashboard & 1-Click 5-Step Demo**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/admin`
- **Live Health Check**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/health`
- **Live Tool Catalog (`/v1/tools`)**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/tools`
- **Live MCP Endpoint (`/mcp`)**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp`
- **Public YouTube Pitch & Demo Video (`2m 36s`)**: `https://youtu.be/ghDr76m1lsQ`
- **Public GitHub Repository**: `https://github.com/nguyenhieuec/agent-clearing-desk`

## 1. The Problem: Unbounded Spend and Zero Auditability in Agentic Tool Calls

Enterprise engineering teams want to connect autonomous agents (Claude Code, Cursor, LangGraph, custom MCP workers) to real commercial data and trade compliance APIs such as EU customs duty calculators, USITC tariff schedules, EU VIES VAT registries, and live recruitment feeds.
Handing an autonomous agent a master upstream API key creates three immediate production failures:

1. **Runaway Spend**: A single hallucinating retry loop can drain hundreds of dollars of API quota in minutes before an asynchronous billing webhook fires.
2. **Lateral Tool Escalation**: A procurement agent that only needs `eu_duty_estimate` and `find_tariff_codes` can accidentally invoke unrestricted tools on the same upstream account.
3. **Unverifiable Chargebacks**: Finance teams have no cryptographic record tying a specific agent key, tool input summary, wholesale cost, and retail charge to an immutable receipt.

## 2. Our Solution: Pre-Flight Clearing & Atomic Settlement at the Edge

Agent Clearing Desk solves all three failure modes in a zero-dependency TypeScript Cloudflare Worker backed by a normalized 4-table Cloudflare D1 SQL ledger (`organizations`, `agent_keys`, `audit_logs`, `receipts`):

- **Zero-Trust Key Isolation (`cd_live_...`)**: Upstream master credentials (`OPENKRILL_API_KEY`, provisioned via OpenKrill Connect, public keyId `05edfbb73f482e29`) remain sealed in the Worker environment.
  Each agent receives a scoped `cd_live_<48hex>` key stored only as a SHA-256 hash (`key_hash`) in D1.
- **Pre-Flight Tool Allowlist (`403 tool_not_allowed`)**: Before any upstream packet leaves the edge, the desk checks the key's JSON allowlist.
  Disallowed tools are blocked in under 5 ms with `$0.00` charged and an immutable `refused_allowlist` audit row.
- **Pre-Flight Budget Circuit Breaker (`402 budget_exceeded`)**: If `spent_cents + price_cents > budget_cents`, the call is halted before upstream execution and returns a structured `402 Payment Required` response with a signed refusal receipt so the agent can degrade gracefully instead of looping blindly.
- **Atomic Wholesale-to-Retail Spread Accounting**: Every call resolves `cost_cents` (upstream wholesale cost), `price_cents` (retail charge to the agent org), and `margin_cents` (net clearing spread), committing the spend update, `aud_<24hex>` audit row, and `rcpt_<24hex>` receipt in a single `db.batch()` transaction.
- **Cryptographic Receipts (`HMAC-SHA256`)**: Every response includes `x-clearing-receipt`, `x-clearing-receipt-hash`, `x-clearing-price-cents`, and `x-clearing-remaining-budget-cents` headers, plus an in-band `get_call_receipt` MCP tool so agents and auditors can verify `signature_valid: true` at any time.

## 3. System Architecture

![Agent Clearing Desk Architecture](./architecture.svg)

| Layer | Component | Responsibility |
| --- | --- | --- |
| **Ingress Protocols** | `src/proxy.ts` (`/v1/*`) & `src/mcp.ts` (`/mcp`) | Dual-protocol ingress supporting standard REST tool execution and MCP `2024-11-05` JSON-RPC (`initialize`, `tools/list`, `tools/call`). |
| **Policy & Metering** | `src/metering.ts` | Evaluates per-key tool allowlists, catalog wholesale costs, per-key pricing overrides, and hard cent-level budget caps. |
| **Upstream Bridge** | `src/upstream.ts` | Routes approved calls to live OpenKrill endpoints (`/plugins/shop-duty/mcp`, `/plugins/tariffs/mcp`, `/plugins/eu-business/mcp`, `/v1/tools/job-boards/run`, `/v1/tools/app-reviews/run`) and reads live `/v1/usage` telemetry. |
| **Cryptographic Signer** | `src/crypto.ts` | Generates `cd_live_` tokens, hashes keys with Web Crypto SHA-256, and signs canonical receipt payloads (`verifyReceipt`). |
| **Relational Ledger** | `src/db.ts` + Cloudflare D1 (`clearing-desk`) | Executes atomic D1 batch writes across `organizations`, `agent_keys`, `audit_logs`, and `receipts`. |
| **FinOps Control Plane** | `src/admin.ts` (`/admin`) | High-contrast dark-mode operator console with KPI strip, 1-click key rotation/revocation, receipt signature inspector, Monetization Blueprint tab, and 1-click 5-Step Live Governance Demo. |

## 4. Reference Benchmark Comparison

We benchmarked Agent Clearing Desk against **LiteLLM Proxy** (`BerriAI/litellm`) and **Helicone AI Gateway** (`Helicone/helicone`):

| Capability | LiteLLM Proxy | Helicone Gateway | Agent Clearing Desk |
| --- | --- | --- | --- |
| **Runtime Footprint** | Python + FastAPI + Postgres + Redis | Node/Rust + ClickHouse + Supabase | Zero-dependency Cloudflare Worker + D1 SQLite |
| **MCP Native Tool Firewall** | Partial | Observability headers | Full JSON-RPC `/mcp` + REST `/v1/tools/:name/run` |
| **Signed Per-Call Receipts** | No | No | Yes (`rcpt_<24hex>`, verifiable via `/v1/receipts/:id` & MCP) |
| **Wholesale vs. Retail Margin Ledger** | Spend tracking only | Cost tracking only | Atomic `cost_cents`, `price_cents`, `margin_cents` per call |
| **1-Click Key Rotation Preserving Spend** | Requires key recreation | Dashboard key swap | Instant `POST /api/admin/keys/:id/rotate` preserving `key_id` & spend |

## 5. Submission Package Contents

- [`README.md`](./README.md) - Executive summary, architecture, and benchmark comparison.
- [`architecture.svg`](./architecture.svg) - Vector architecture diagram of the edge clearing flow.
- [`judge-steps.md`](./judge-steps.md) - 30-second 1-click browser test and copy-paste `curl` verification steps.
- [`checklist.md`](./checklist.md) - Galuxium Nexus V2 requirement and judging criteria mapping.
- [`video.md`](./video.md) - Narrated pitch and demo video script with timecoded line-to-shot table.
- [`e2e-live-output.json`](./e2e-live-output.json) - Saved output of the 12-step live verification run against `https://agent-clearing-desk.nguyenhieuec.workers.dev`.
- [`screenshots/`](./screenshots/) - Real 1440x900 screenshots of the deployed `/admin` control plane.
