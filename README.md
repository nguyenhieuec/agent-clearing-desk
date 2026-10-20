# Agent Clearing Desk

A spend gate for AI agents that call paid tools.
Each agent key has a hard budget and a tool allowlist; every call is cleared before it runs and returns an Ed25519-signed receipt that anyone can verify offline.

- Live desk and judge sandbox: https://agent-clearing-desk.nguyenhieuec.workers.dev
- MCP endpoint: `/mcp` (Streamable HTTP, JSON responses)
- REST: `POST /v1/tools/:name/run`
- Public signing key: `/.well-known/receipt-signing-key.json`
- Galuxium Nexus V2 package: [submission/galuxium/](./submission/galuxium/README.md)

![Architecture](./submission/galuxium/architecture.svg)

## How a call is cleared

1. Unknown tool: 404. Missing required arguments: 400. Nothing is charged.
2. Tool not on the allowlist: 403 with a signed receipt.
3. One conditional `UPDATE` reserves the price; if the budget has no room, 402 with a signed receipt.
4. The upstream runs. On failure or timeout the reservation is refunded (502 or 504).
5. On success the price is charged and the receipt signs the input hash, result hash, amount and upstream cost.

Money is integer millicents.
The audit log and receipts are append-only.
Receipts are visible only within their organization.

## Run it

```bash
npm install
npm test                    # real SQLite (node:sqlite, Node 22.5+), production migration
npm run typecheck
npm run db:migrate:local
npm run dev
```

Secrets for a deployment:

| Secret | What it is |
| --- | --- |
| `RECEIPT_SIGNING_KEY` | Ed25519 private key as JWK JSON |
| `ADMIN_SECRET` | Bearer token for `/api/admin/*` (unset: the admin API is closed) |
| `OPENKRILL_REFRESH_TOKEN` | OpenKrill Connect refresh token; seeds the first refresh, later tokens rotate in D1 |
| `OPENKRILL_API_KEY` | Optional static OpenKrill API key; when set it replaces the Connect token |

`OPENKRILL_CLIENT_ID` (the Connect client) is a plain var in `wrangler.jsonc`.
If a refresh token ever stops working, set a new seed and delete the `upstream_credentials` row.

Scripts:

- `scripts/run-e2e.mjs`: live end-to-end run (operator flow with `ADMIN_SECRET`).
- `scripts/verify-receipt.mjs`: offline receipt check with the public key.
- `scripts/sync-tool-schemas.mjs`: copies input schemas from the upstreams.

## License

MIT
