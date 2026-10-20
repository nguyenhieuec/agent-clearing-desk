# Agent Clearing Desk

A spend gate for AI agents that call paid tools.
Each agent key has a hard budget (one-off, daily or monthly) and a tool allowlist; every call is cleared before it runs and returns an Ed25519-signed receipt that anyone can verify offline.

- Live desk and judge sandbox: https://agent-clearing-desk.nguyenhieuec.workers.dev
- MCP endpoint: `/mcp` (Streamable HTTP, JSON responses)
- REST: `POST /v1/tools/:name/run`
- Public signing key: `/.well-known/receipt-signing-key.json`
- Galuxium Nexus V2 package: [submission/galuxium/](./submission/galuxium/README.md)

![Architecture](./submission/galuxium/architecture.svg)

## How a call is cleared

1. Unknown tool: 404. Arguments that break the input schema: 400 with the problems. Nothing is charged.
2. Tool not on the allowlist: 403 with a signed receipt. Too many failed calls this hour: 429.
3. One conditional `UPDATE` reserves the price; if the budget has no room, 402 with a signed receipt.
4. The upstream runs. On failure, timeout or refused arguments the reservation is refunded to its own budget period (502, 504 or 400).
5. On success the price is charged and the receipt signs the input hash, result hash, amount and upstream cost (SHA-256 over canonical JSON).

Operators add a tool from any MCP server at run time with `POST /api/admin/tools`; the desk runs the MCP session handshake and reads that server's `tools/list` for the schema.
An optional upstream credential header is sealed with AES-256-GCM and never returned.
Money is integer millicents.
The audit log and receipts are append-only.
Receipts are visible only within their organization.

## Run it

```bash
npm install
npm test                    # real SQLite (node:sqlite, Node 22.5+), production migrations
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
| `UPSTREAM_SECRET_KEY` | 32 random bytes in base64; seals credentials of operator-added MCP servers (unset: such credentials are refused) |

`OPENKRILL_CLIENT_ID` (the Connect client) is a plain var in `wrangler.jsonc`.
If a refresh token ever stops working, set a new seed and delete the `upstream_credentials` row.

Scripts:

- `scripts/run-e2e.mjs`: live end-to-end run (operator flow with `ADMIN_SECRET`).
- `scripts/verify-receipt.mjs response.json [public-key.json] [--input args.json]`: offline check of the signature, the result hash, the input hash and the readable copy; takes a REST response, an MCP `tools/call` result or a bare receipt.
- `scripts/sync-tool-schemas.mjs`: copies input schemas from the upstreams.

## License

MIT
