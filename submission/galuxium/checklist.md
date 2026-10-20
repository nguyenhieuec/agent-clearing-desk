# Galuxium Nexus V2 checklist

Event: Galuxium Nexus V2, https://galuxium-nexus-v2-29411.devpost.com/
Deadline: 2026-10-31 17:00 IST (18:30 GMT+7).

## Judging criteria

| Criterion | What the entry shows | Where to check |
| --- | --- | --- |
| Quality of the idea | A spend gate for paid agent tools: per-key budgets (one-off, daily or monthly) and allowlists, atomic reservation with refund, and a signed receipt for every charge and every refusal that proves the input and the answer. Built-in tools on two upstreams, plus any MCP server an operator adds at run time. | [README](./README.md), [architecture.svg](./architecture.svg) |
| Implementation | Deployed on its own Worker and D1. 51 tests on real SQLite, written as attacks on the gate. 43 of 43 live e2e checks, including a 10-call concurrency burst, a tool added at run time, one with a sealed credential, a schema refusal with no charge and the 4-part offline proof. | [e2e-live-output.json](./e2e-live-output.json), `npm test` |
| Potential value | Each call records upstream cost, price and margin, so an operator can resell tool access to agents with proof of every charge. | Operator console, [screenshots/04-console-1440.png](./screenshots/04-console-1440.png) |

## Submission parts

| Part | Status |
| --- | --- |
| Working product on a public URL | https://agent-clearing-desk.nguyenhieuec.workers.dev |
| Public source | https://github.com/nguyenhieuec/agent-clearing-desk (MIT) |
| Pitch video, 2 to 5 minutes | https://youtu.be/67ObmB3BAAw (3:28), script in [video.md](./video.md) |
| Write-up | [README.md](./README.md) |
| Screenshots | [screenshots/](./screenshots/) at 1440 px and 390 px |
| Steps a judge can repeat | [judge-steps.md](./judge-steps.md) |

## Safety of the public demo

- The admin API needs a bearer token; without one it answers 401, and 503 if no token is set.
- Sandbox keys hold 2 cents, 2 tools and live 60 minutes, each in its own organization; at most 100 are minted per UTC day.
- The upstream API key never leaves the Worker. Credentials of operator-added servers are sealed with AES-256-GCM and never returned.
- Bad arguments get 400 before any spend, and after 20 failed calls on a key in one UTC hour the next call gets 429, so free failures cannot hammer an upstream.
- Paid mode is off: prices are metered in the ledger, no card is charged.
