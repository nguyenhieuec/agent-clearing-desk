# Pitch video

- Length: 2 minutes 43 seconds, 1920x1080, 30 fps.
- Public link: https://youtu.be/z89trfiVLAE
- Every claim comes from the live desk, the tests or the live e2e run.
- The demo part is a screen recording of the deployed desk, not a mock-up.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00 | The live desk home page | Agents now call paid tools: customs duty, VAT checks, job feeds, code search. Most of the time the agent holds the master API key. One retry loop can spend the whole quota. The agent can reach any tool on the account. And finance has no record that ties a charge to an agent. |
| 0:20 | `architecture.svg` | Agent Clearing Desk is a spend gate between agents and those tools. It is one Cloudflare Worker with one D1 database. Each agent gets its own key, with a hard budget and a tool allowlist. Every call, over REST or MCP, takes the same path. Check the tool, the arguments and the allowlist. Reserve the price with one atomic SQL update. Call the upstream. Then sign a receipt. |
| 0:45 | Screen recording: **Run the live demo** | This is the live desk. Step 1 mints a sandbox key: two cents, two allowed tools. Step 2 calls the EU duty estimate on the real OpenKrill upstream: 200, one cent charged. Step 3 asks for app reviews, which is not on the allowlist: 403, nothing charged, and still a signed receipt. Step 4 checks a VAT number against EU VIES, and the budget is now used up. Step 5 tries the duty estimate again: 402, and the upstream is never called. |
| 1:20 | Screen recording: steps 6 and 7 | Step 6: the browser fetches the public key and checks the receipt from step 2 with WebCrypto. A copy with one changed field fails. Step 7 rotates the key. The old secret gets 401. The new one keeps the spend. |
| 1:40 | Terminal: burst result and `verify-receipt.mjs` | The budget check is one conditional update, so it holds under load. On the live desk, 10 calls at once on a key with room for one gave exactly one 200 and nine 402s. Receipts are Ed25519 over canonical JSON, so anyone can check one offline with the public key. Change one digit of the amount, and the check fails. If the upstream fails or times out, the price is refunded in the same batch that writes the receipt. |
| 2:05 | Operator console and audit log | Operators get a console behind a bearer token. It creates organizations and keys, and sets budgets, allowlists and prices. It rotates and revokes keys, and shows each call with its upstream cost, price and margin. The audit log and the receipts are append-only in the database. A receipt is visible only inside its own organization. |
| 2:30 | Comparison table, then the desk URL | LiteLLM and Helicone already give per-key budgets for LLM traffic. Neither signs a receipt you can check offline. The desk is the money and proof layer for tool calls, and it can sit beside them. Try it now at agent-clearing-desk.nguyenhieuec.workers.dev. No account needed. |
