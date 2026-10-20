# Agent Customer Check: Agent Clearing Desk

Evaluation conducted against the live deployed Agent Clearing Desk Cloudflare Worker (`https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp`).
Evaluator model: `claude-haiku-5-5` discovering tools dynamically via MCP `tools/list` and executing tool calls via MCP `tools/call`.
Prompts were phrased as natural customer requests with no tool names or schema hints.

## Pass Bar Requirements

- At least 4 of 5 positive tasks pick the right tool with no human hint.
- No negative task calls any tool.
- Failing picks must be diagnosed and resolved in tool descriptions.

## Results Summary

| Metric | Target | Actual | Verdict |
| --- | --- | --- | --- |
| Positive Tasks | >= 4 / 5 | 5 / 5 | PASS |
| Negative Tasks (Zero Tool Calls) | 3 / 3 | 3 / 3 | PASS |
| Overall Pass Bar | Met | Met | **PASSED** |

## Task Log

| # | Type | Prompt | Expected Tool | Tool Chosen | Duration | Result | Notes |
|---|---|---|---|---|---|---|---|
| 1 | positive | "Check the EU duty on 3 T-shirts valued at 75 EUR from the US, and tell me the signed clearing receipt ID." | `eu_duty_estimate` | `eu_duty_estimate` | 21.8s | **PASS** | Invoked `eu_duty_estimate` on live Worker and reported the signed `rcpt_*` receipt ID. |
| 2 | positive | "Find open remote engineer jobs on Greenhouse and tell me how many cents the clearing call cost." | `list_jobs` | `list_jobs, check_agent_balance` | 28.1s | **PASS** | Invoked `list_jobs` and `check_agent_balance`, reporting live Greenhouse postings and the 2-cent clearing fee. |
| 3 | positive | "Check customer reviews and ratings for the Notion app (id366500020) on the US iOS App Store." | `get_app_reviews` | `get_app_reviews` | 41.1s | **PASS** | Invoked `get_app_reviews` for iOS App ID `366500020` and summarized live reviews. |
| 4 | positive | "What is the tariff code and duty info for ceramic coffee mugs?" | `find_tariff_codes` | `find_tariff_codes` | 55.4s | **PASS** | Invoked `find_tariff_codes` and returned USITC HTS classification and duty rates. |
| 5 | positive | "Verify whether German VAT number DE123456789 is valid in the EU VIES registry." | `check_vat_number` | `check_vat_number` | 12.5s | **PASS** | Invoked `check_vat_number` with country `DE` and number `123456789`. |
| 6 | negative | "Write a 3-sentence poem about autumn rain." | `none` | `none` | 1.7s | **PASS** | No tool called. Pure conversational completion. |
| 7 | negative | "Explain the difference between synchronous and asynchronous programming in two short sentences." | `none` | `none` | 1.5s | **PASS** | No tool called. Pure conversational completion. |
| 8 | negative | "What is 144 divided by 12?" | `none` | `none` | 1.3s | **PASS** | No tool called. Pure conversational completion. |
