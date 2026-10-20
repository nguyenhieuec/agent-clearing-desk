# Agent Clearing Desk

**Agent Clearing Desk** is an enterprise FinOps control plane, policy firewall, and cryptographic settlement proxy for autonomous AI agents.
Built on Cloudflare Workers and Cloudflare D1, it sits between AI agents (`MCP JSON-RPC 2.0` and `HTTP REST /v1/*`) and upstream tool APIs to enforce per-key cent-level spending caps, strict tool allowlists, instant key rotation, wholesale-to-retail spread accounting, and HMAC-SHA256 signed audit receipts.

- **Live FinOps Dashboard & 5-Step Interactive Demo**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/admin`
- **Live Health Check**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/health`
- **Live Tool Catalog**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/v1/tools`
- **Live MCP Endpoint**: `https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp`
- **Galuxium Nexus V2 Submission Package**: [`submission/galuxium/`](./submission/galuxium/README.md)

## Architecture

![Agent Clearing Desk Architecture](./submission/galuxium/architecture.svg)

## Key Features

1. **Scoped Agent Keys (`cd_live_...`)**: Plaintext keys are shown once at creation or rotation and stored exclusively as SHA-256 hashes (`key_hash`) in Cloudflare D1.
2. **Pre-Flight Tool Allowlists (`403 tool_not_allowed`)**: Unauthorized tools are blocked at the edge before any upstream request is made, recording an immutable `refused_allowlist` audit entry at `$0.00` cost.
3. **Pre-Flight Budget Circuit Breakers (`402 budget_exceeded`)**: Calls that would exceed `budget_cents` are stopped pre-flight and return a structured `402 Payment Required` error with a signed refusal receipt (`rcpt_...`).
4. **Live OpenKrill Upstream Integration**: Connects to live production OpenKrill tools (`eu_duty_estimate`, `find_tariff_codes`, `check_vat_number`, `list_jobs`, `get_app_reviews`) and verifies upstream metering via `/v1/usage`.
5. **Cryptographic Audit Receipts (`rcpt_<24hex>`)**: Every transaction is committed atomically in D1 (`db.batch`) with a matching `aud_<24hex>` audit row and `rcpt_<24hex>` signed receipt verifiable at `GET /v1/receipts/:id` or via the MCP `get_call_receipt` tool.
6. **Zero-Downtime Key Rotation**: `POST /api/admin/keys/:id/rotate` swaps the underlying `key_hash` while preserving `key_id`, historical receipts, and accumulated spend.

## Quickstart

```bash
npm install
npm run db:migrate:local
npm test
npm run typecheck
npm run e2e
```

See [`submission/galuxium/judge-steps.md`](./submission/galuxium/judge-steps.md) for 30-second browser and `curl` verification against the live deployment.

## License

MIT
