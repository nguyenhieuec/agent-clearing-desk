# Agent Clearing Desk

A spend gate for AI agents that call paid tools.
Each agent gets its own key with a hard budget and a tool allowlist.
Every call is cleared before it runs and returns a receipt that anyone can verify offline.

- Live desk and judge sandbox: https://agent-clearing-desk.nguyenhieuec.workers.dev
- MCP endpoint: https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp
- Public signing key: https://agent-clearing-desk.nguyenhieuec.workers.dev/.well-known/receipt-signing-key.json
- Source: https://github.com/nguyenhieuec/agent-clearing-desk
- Pitch video (2:43): https://youtu.be/z89trfiVLAE

## The problem

Teams want agents to call paid data APIs: customs duty, VAT registries, job feeds, code search.
Today the agent usually holds the master API key.
Then one retry loop can spend the whole quota, the agent can call any tool on that account, and finance has no record that ties a charge to an agent and an input.

## What the desk does

The desk sits between agents and the upstream tools, over REST (`POST /v1/tools/:name/run`) and MCP (`/mcp`).
Upstream credentials stay in the Worker; agents only hold scoped `cd_live_` keys, stored as SHA-256 hashes.
For OpenKrill the desk is a Connect OAuth client: it refreshes its 1 hour access token itself and keeps the rotating refresh token in D1.

For each call the desk runs one path:

1. Unknown tool: 404. Missing required arguments: 400. Nothing is written or charged.
2. Tool not on the key's allowlist: 403, a signed receipt, no upstream call.
3. Reserve the price with one conditional SQL `UPDATE ... WHERE spent_mc + price <= budget_mc`.
   If no row changes, the call gets 402 and a signed receipt.
   This is atomic: 20 concurrent calls on a key with room for one give exactly one success in the tests, and 10 concurrent calls on the live desk gave 1 x 200 and 9 x 402.
4. Call the upstream. If it fails or times out, the reservation is refunded in the same batch that writes the receipt (502).
5. On success, the desk charges the price and signs the receipt.

Every receipt is Ed25519 over a canonical JSON payload.
The payload holds the key, org, tool, upstream, outcome, HTTP status, amount, upstream cost, a SHA-256 of the input and a SHA-256 of the result.
Anyone with the public key can check it, with no call to the desk: `node scripts/verify-receipt.mjs receipt.json`, or WebCrypto in a browser.
Changing one digit of the amount makes the check fail.

Money is integer millicents (1/1000 of a cent), and a CHECK constraint makes `spent > budget` impossible even outside the reservation path.
Database triggers make the audit log and the receipts append-only.
A receipt is visible only to keys of the same organization.

## Two upstreams, one gate

| Upstream | Protocol | Tools |
| --- | --- | --- |
| OpenKrill | MCP plugins | `eu_duty_estimate`, `find_tariff_codes`, `check_vat_number` |
| OpenKrill | REST | `list_jobs`, `get_app_reviews`, `get_transcript` |
| DeepWiki (public) | MCP, SSE answers | `ask_repo_question` |

Arguments pass through unchanged.
Input schemas are copied from the upstreams by `scripts/sync-tool-schemas.mjs`.
There is no fallback data: if the upstream fails, the agent gets an error and pays nothing.
Two free desk tools, `check_agent_balance` and `get_call_receipt`, let an agent see where it stands.

## Who operates it

- Operator: an admin API behind a bearer secret (`/api/admin/*`) creates organizations and keys, sets budgets, allowlists and per-key prices, rotates and revokes keys, and reads the audit log with upstream cost, price and margin per call.
- Agent: can rotate its own key (`POST /v1/key/rotate`); the old secret stops at once, spend is kept.
- Judge: `POST /api/demo/keys` gives anyone a sandbox key with a 2 cent budget, 2 allowed tools and a 60 minute life. The whole sandbox is capped at 100 keys per UTC day, so the public demo cannot drain the upstream account.

## Architecture

![Architecture](./architecture.svg)

One TypeScript Cloudflare Worker with no runtime dependencies, and one D1 database with 5 ledger tables (`organizations`, `agent_keys`, `audit_logs`, `receipts`, `usage_events`) and one for the upstream token (`upstream_credentials`).

| File | Job |
| --- | --- |
| `src/clearing.ts` | The one clearing path for REST and MCP |
| `src/db.ts` | Atomic reservation, ledger batch, readers |
| `src/crypto.ts` | Key hashing, Ed25519 signing and verification |
| `src/upstream.ts` | MCP (JSON or SSE) and REST upstream calls, timeouts |
| `src/openkrill-auth.ts` | OpenKrill Connect token refresh, rotating refresh token in D1 |
| `src/tools.ts` | Governed tools, cost and price per call |
| `src/proxy.ts`, `src/mcp.ts` | REST and MCP front doors |
| `src/admin.ts` | Operator API and the capped public sandbox |
| `public/` | Judge sandbox and operator console |

## How it compares

Checked against the source of each project on 2026-10-20.

| | LiteLLM Proxy | Helicone | Agent Clearing Desk |
| --- | --- | --- | --- |
| Main job | LLM routing for many providers | LLM observability | Spend gate for paid agent tools |
| Per-key budget | Yes, also counts MCP tool calls | Yes, cost limits answer 429 | Yes, reserved atomically before the call |
| Per-key MCP tool allowlist | Yes | No | Yes |
| Refund when the upstream fails | Not documented | Not documented | Yes, same batch as the receipt |
| Signed per-call receipt, verifiable offline | No | No | Yes, Ed25519, also for refusals |
| Upstream cost vs price per call | Spend only | Cost only | Cost, price and margin |

LiteLLM and Helicone do far more for LLM traffic.
The desk is narrower: it is the money and proof layer for tool calls, and it can sit beside them.

## Evidence

- `npm test`: 20 tests on real SQLite (`node:sqlite`) with the same migrations as production. Only the upstreams and the OpenKrill token endpoint are faked.
- [`e2e-live-output.json`](./e2e-live-output.json): 24 of 24 live checks against the deployed desk, with real upstream calls.
- [`judge-steps.md`](./judge-steps.md): what a judge can repeat in a browser or with curl.
- [`checklist.md`](./checklist.md): requirement mapping.
