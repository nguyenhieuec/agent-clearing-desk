# Galuxium Nexus V2 Submission Checklist

Event: **Galuxium Nexus V2** (`https://galuxium-nexus-v2-29411.devpost.com/`)
Deadline: **2026-10-31 17:00 IST (18:30 GMT+7)**
Entry: **Agent Clearing Desk** (`hackathons/clearing-desk`)

## 1. Devpost Rules & Judging Criteria Alignment

| Criterion / Requirement | Implementation in Agent Clearing Desk | Verification |
| --- | --- | --- |
| **Quality of the Idea** (Creativity & originality) | First FinOps clearing house for autonomous AI agents that unifies pre-flight tool allowlists, hard cent-level budget circuit breakers, wholesale-vs-retail margin accounting, and HMAC-SHA256 signed receipts across both REST (`/v1/*`) and MCP (`/mcp`). | `README.md`, `architecture.svg`, `/admin` Monetization Blueprint tab |
| **Implementation of the Idea** (Real working execution) | Deployed on its own Cloudflare Worker (`https://agent-clearing-desk.nguyenhieuec.workers.dev`) and dedicated D1 SQL database (`clearing-desk`, ID `78efd2d3-f032-4334-a6ba-511beea829a8`), wired to a production OpenKrill Connect token (key ID `05edfbb73f482e29`). | `submission/galuxium/e2e-live-output.json` (all 12 live steps passing) |
| **Potential Value** (Monetization & enterprise adoption) | Built-in wholesale/retail clearing spread (`cost_cents`, `price_cents`, `margin_cents`) recorded atomically on every D1 transaction, giving AI platform teams immediate cost recovery and gross-margin visibility. | `/api/admin/overview` and `/admin` Monetization Blueprint tab |
| **2-5 Minute Pitch & Demo Video** | Narrated 155-second (`2m 35s`) 1080p pitch and live product walkthrough with `-14 LUFS` sound layer (`opus-sound-layer`) and timecoded shot table (`video.md`). | `https://youtu.be/ghDr76m1lsQ` & `/mnt/drive/outputs/at-hack-galuxium/galuxium-pitch-demo.mp4` |
| **Public Code Repository** | Standalone MIT-licensed repository published with zero internal fleet leaks. | `https://github.com/nguyenhieuec/agent-clearing-desk` |
| **Run-It-Yourself Judge Instructions** | 1-click browser verification plus copy-paste `curl` and MCP JSON-RPC commands. | `submission/galuxium/judge-steps.md` |

## 2. Finest-Detail & Quality Gates

- **Named Reference Benchmark**: LiteLLM Proxy (`BerriAI/litellm`) and Helicone AI Gateway (`Helicone/helicone`), plus 8 additional reference systems across agentic commerce and API metering.
- **How Agent Clearing Desk Exceeds the Reference**: Adds cryptographic per-call receipts (`rcpt_<24hex>`) that agents can inspect in-band via MCP (`get_call_receipt`), zero-dependency Cloudflare Worker + D1 deployment, and wholesale-to-retail spread accounting.
- **Complexity & Lint Gate**: `node scripts/check-complexity.mjs hackathons/clearing-desk` exits `0` (0 warnings, max cognitive complexity 13, max cyclomatic complexity 13).
- **Agent-Customer E2E Check**: Verified with `claude-haiku-5-5` acting as an autonomous buyer agent discovering tools, checking balances, handling 403/402 refusals, and verifying receipts.
- **Humanize Pass**: `humanized: yes, fact diff clean` on all submission prose.
- **Independent Reviewer Gate**: Scored `>= 8/10` by separate `gemini-4-argon-high` plan-mode review.
