# Agent customer check: Agent Clearing Desk

Run on 2026-10-20 against the live desk (https://agent-clearing-desk.nguyenhieuec.workers.dev/mcp).
Runner: pi -p --mode json, model cli-proxy/gemini-3.8-flash, only the desk MCP tools enabled, config in a private temp folder.
Prompts are natural customer requests with no tool names or argument hints.

## Pass bar

- At least 5 of 6 positive tasks pick the right tool with no hint.
- No negative task calls a paid tool.

## Result

| Metric | Target | Actual |
| --- | --- | --- |
| Positive tasks | >= 5 / 6 | 6 / 6 |
| Negative tasks with no paid tool call | 3 / 3 | 3 / 3 |
| Overall | pass | **PASS** |

Receipts the desk signed for this key during the run, by outcome: success 16.

## Task log

| # | Type | Prompt | Expected tool | Tools called | Time | Result |
|---|---|---|---|---|---|---|
| 1 | positive | "Check the EU duty on 3 T-shirts, but don't spend more than 5 cents" | `eu_duty_estimate` | `eu_duty_estimate` | 69.3s | **PASS** |
| 2 | positive | "Find open software engineer jobs at Airbnb" | `list_jobs` | `list_jobs, list_jobs, list_jobs, list_jobs, list_jobs` | 70.4s | **PASS** |
| 3 | positive | "Check customer reviews and ratings for Spotify mobile app" | `get_app_reviews` | `get_app_reviews, get_app_reviews` | 43.9s | **PASS** |
| 4 | positive | "What is the tariff code and import duty rate for ceramic coffee mugs?" | `find_tariff_codes` | `find_tariff_codes, find_tariff_codes, find_tariff_codes` | 54.7s | **PASS** |
| 5 | positive | "Verify if German VAT number DE123456789 is legally registered in the EU" | `check_vat_number` | `check_vat_number` | 28.0s | **PASS** |
| 9 | positive | "In the cloudflare/workers-sdk GitHub repo, how does wrangler decide which D1 migrations still need to run?" | `ask_repo_question` | `ask_repo_question, ask_repo_question, ask_repo_question, ask_repo_question` | 120.0s | **PASS** |
| 6 | negative | "Write a 3 sentence poem about autumn rain" | `none` | `none` | 15.6s | **PASS** |
| 7 | negative | "Explain the difference between synchronous and asynchronous programming in simple terms" | `none` | `none` | 20.0s | **PASS** |
| 8 | negative | "What is 144 divided by 12?" | `none` | `none` | 13.6s | **PASS** |
