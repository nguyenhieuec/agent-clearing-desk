# Judge steps

Everything below runs against the live desk.
No account is needed.

## 1. In a browser (about 1 minute)

1. Open https://agent-clearing-desk.nguyenhieuec.workers.dev
2. Click **Run the live demo**.
3. Watch the 7 steps. Each shows the real request, status, `x-clearing-*` headers and latency:
   1. Mint a sandbox key: 201, 2 cent budget, 2 allowed tools.
   2. `eu_duty_estimate` on the real upstream: 200, 1 cent charged.
   3. `get_app_reviews` (not allowed): 403, 0 charged, signed receipt.
   4. `check_vat_number` against EU VIES: 200, budget now used up.
   5. `eu_duty_estimate` again: 402, signed receipt, no upstream call.
   6. The browser fetches the public key and checks the step 2 receipt with WebCrypto: the signature, and that the SHA-256 of the answer from step 2 is the signed `result_sha256`. A copy with one changed field fails.
   7. The key rotates: the old secret gets 401, the new one gets 200 with the spend kept.
   If a live upstream is down the step shows 502, and if it is slower than the tool's timeout it shows 504, both with `upstream_error`: the reservation is refunded and the receipt still verifies. Run the demo again with a new key.
4. Use **Verify offline** on any receipt in the side panel, or the **Agent call simulator** to call a tool yourself.

## 2. With curl

```bash
DESK=https://agent-clearing-desk.nguyenhieuec.workers.dev

# a sandbox key: 2 cents, eu_duty_estimate + check_vat_number, 60 minutes
KEY=$(curl -s -X POST $DESK/api/demo/keys | node -pe 'JSON.parse(require("fs").readFileSync(0)).key')

# cleared: 200, 1 cent, signed receipt in the body and the headers
echo '{"lines":[{"description":"cotton t-shirt","origin":"CN","qty":3,"unit_value_eur":25}],"channel":"ioss"}' > args.json
curl -s -D - -X POST $DESK/v1/tools/eu_duty_estimate/run -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d @args.json -o receipt-call.json | grep x-clearing

# not on the allowlist: 403, nothing charged
curl -s -o /dev/null -w '%{http_code}\n' -X POST $DESK/v1/tools/get_app_reviews/run -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -d '{"apps":["com.spotify.music"]}'

# arguments that break the schema: 400 with the problems, nothing charged, no upstream call
curl -s -X POST $DESK/v1/tools/check_vat_number/run -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"country":"IE","vatNumber":"1"}'

# where the key stands
curl -s $DESK/v1/usage -H "x-api-key: $KEY"

# the admin API is closed without the operator token
curl -s -o /dev/null -w '%{http_code}\n' $DESK/api/admin/keys
```

## 3. Verify a receipt offline

```bash
git clone https://github.com/nguyenhieuec/agent-clearing-desk && cd agent-clearing-desk
curl -s https://agent-clearing-desk.nguyenhieuec.workers.dev/.well-known/receipt-signing-key.json > public-key.json
node scripts/verify-receipt.mjs ../receipt-call.json public-key.json --input ../args.json
# {"valid":true,"proves_answer":true,"checks":{"signature":true,"result_hash":true,"input_hash":true,"unsigned_view":true},...}
```

The script checks the Ed25519 signature over `payload`, the SHA-256 of `result` against the signed `result_sha256`, the SHA-256 of your arguments against the signed `params_sha256`, and that the readable `unsigned_view` matches the signed `payload`.
It exits 0 when every check passes and 1 when one fails.
The hashes are over canonical JSON, so `args.json` may list its keys in any order.
A file with only the receipt still checks the signature, but says `proves_answer: false`: it proves the charge, not the answer.

Now change the signed amount and check again:

```bash
node -e 'const f="../receipt-call.json",d=JSON.parse(require("fs").readFileSync(f));d.receipt.payload=d.receipt.payload.replace(/"amount_mc":\d+/,"\"amount_mc\":1");require("fs").writeFileSync("../forged.json",JSON.stringify(d))'
node scripts/verify-receipt.mjs ../forged.json public-key.json
# {"valid":false,"checks":{"signature":false,...}}
```

Or keep the receipt and change the answer: edit any value inside `result` in a copy of the file, and `result_hash` turns false.

## 4. As an MCP client

Add the desk as a Streamable HTTP MCP server with the sandbox key in a header:

```json
{
  "mcpServers": {
    "clearing-desk": {
      "type": "http",
      "url": "https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp",
      "headers": { "x-api-key": "cd_live_..." }
    }
  }
}
```

`tools/list` shows 9 tools: 7 built-in governed tools, each with its price per successful call in the description, plus the free `check_agent_balance` and `get_call_receipt`.
A `tools/call` result carries the answer and the whole signed receipt in `structuredContent.clearing.receipt`; save it and run `node scripts/verify-receipt.mjs mcp-result.json public-key.json --input args.json`.
`get_call_receipt` returns a stored receipt with `signature_valid` checked on the desk.
Tools an operator adds from another MCP server at run time appear in the same list.

## 5. Run the tests

```bash
npm install
npm test          # 39 tests on real SQLite with the production migrations
npm run typecheck
node scripts/run-e2e.mjs out.json   # live sandbox flow; the operator flow needs ADMIN_SECRET
```

Node 22.5 or newer is needed for `node:sqlite`.
