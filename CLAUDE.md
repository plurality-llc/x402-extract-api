# CLAUDE.md — x402 Extract API

## Code Style Principles

**Balance cleanliness with completeness.** Code should be:

### Clean (Opus-style)
- **Concise**: No unnecessary abstractions or helper functions for one-time operations
- **Readable**: Self-explanatory code over excessive comments
- **Minimal**: Only include what's needed for the feature
- **Consistent**: Follow existing patterns in the codebase

### Complete (Production-ready)
- **All edge cases handled**: Loading, error, empty states
- **All validations in place**: Prevent invalid data states

### The Rule
> Write the **minimum code** needed to be **fully complete**.


## Project overview

A paid API that extracts structured intelligence from web pages, gated by the x402 payment protocol. AI agents discover this service on the x402 Bazaar, pay per call in USDC on Base, and receive clean structured JSON.

**Owner:** Michael / Plurality LLC
**Stack:** Node.js 20+ / Express 4 / x402 v2 SDK / Anthropic Claude API / Playwright (stealth) / Cheerio (fallback) / SQLite cache
**Deploy target:** Railway (Hobby plan)
**Production URL:** https://x402-extract-api-production.up.railway.app
**Payment:** USDC on Base via x402 protocol (currently testnet: Base Sepolia)

## Architecture

```
Request → x402 middleware (payment verification) → Express route → fetchPageContent → Claude extraction → structured JSON response
```

Page fetching pipeline:
1. Reddit URLs → JSON API bypass (no bot detection)
2. PLAYWRIGHT_ALWAYS=true → Stealth Playwright with innerText extraction
3. Fallback → Cheerio static HTML parsing
4. Cache check before Claude call (SQLite, intent-based TTLs)

### Files

- `src/server.js` — Express app, x402 middleware, routes, Bazaar discovery, metrics
- `src/extract.js` — Page fetching (Playwright/Cheerio/Reddit), Claude prompts, caching
- `src/x402-client.js` — Custom x402 payment client (fixes POST body issue in official SDK)
- `test/test-local.js` — Local testing (402 flow + direct extraction, bypasses payment)
- `test/test-paid.js` — Full x402 payment flow testing against local or production

## Pricing

| Endpoint | Price | Model | Use case |
|----------|-------|-------|----------|
| GET /extract | $0.03 | Haiku | Single URL, preset intent |
| POST /extract | $0.05 | Sonnet (custom) / Haiku (preset) | Single URL, custom schema |
| POST /extract/batch | $0.25 | Varies | Up to 5 URLs, any intent |
| POST /valuate | $0.10 | TBD | Coming soon (Phase 2) |

## Intents

| Intent | Model | Cache TTL |
|--------|-------|-----------|
| product_specs | Haiku | 6h |
| company_info | Haiku | 24h |
| article_summary | Sonnet | 24h |
| pricing | Haiku | 2h |
| job_listing | Haiku | 2h |
| reviews | Sonnet | 12h |
| contact_extraction | Haiku | 24h |
| structured_table | Haiku | 12h |
| social_profile | Haiku | 12h |
| custom | Sonnet | 1h |

## Key decisions

- **Express 4, not 5.** The x402 middleware has known issues with Express 5 route matching. Stay on 4.
- **@x402/express v2 SDK (^2.8.0).** Uses the modular package structure (@x402/core, @x402/evm, @x402/extensions).
- **Bazaar discovery enabled.** Routes include `declareDiscoveryExtension()` so the API auto-lists on the Bazaar.
- **Playwright-first (stealth).** Uses `playwright-extra` with stealth plugin for anti-bot evasion. `innerText` extraction preserves visual text layout (critical for prices split across DOM elements).
- **Reddit JSON API bypass.** Reddit URLs automatically use the `.json` endpoint — no bot detection, clean structured data.
- **Custom x402 client wrapper.** The official `wrapFetchWithPayment` drops POST method/body on retry. `src/x402-client.js` fixes this.
- **SQLite cache with intent-based TTLs.** Keyed on sha256(url+intent+schema). Cache hits skip both fetch and Claude — pure margin.
- **Anti-hallucination system prompt.** Claude instructed to only extract explicitly stated data, never infer or guess.
- **Model routing.** Haiku for structured extraction, Sonnet for analytical intents and custom schemas. Custom uses Sonnet because agents paying $0.05+ expect quality.
- **max_tokens: 8000.** Ceiling, not target — prevents truncated JSON on content-rich pages (e.g., Reddit threads).

## Environment variables

Required:
- `PAY_TO_ADDRESS` — Base wallet address receiving USDC
- `ANTHROPIC_API_KEY` — Claude API key
- `NETWORK` — "base-sepolia" (testnet) or "base" (mainnet)
- `METRICS_KEY` — Secret for accessing GET /metrics
- `PLAYWRIGHT_ALWAYS` — "true" for Playwright-first rendering

Optional (mainnet only):
- `CDP_API_KEY_ID` — Coinbase Developer Platform key ID
- `CDP_API_KEY_SECRET` — CDP key secret

## Development workflow

```bash
npm run dev                              # Start with --watch
node test/test-local.js                  # Test health + 402 response
node test/test-local.js --extract        # Test extraction directly (bypasses x402)
node test/test-paid.js http://localhost:4021  # Test full payment flow locally
node test/test-paid.js                   # Test full payment flow against production
```

## Monitoring

```bash
# Check metrics (requires key)
curl -H "X-Metrics-Key: YOUR_KEY" https://x402-extract-api-production.up.railway.app/metrics
```

Returns: request counts by intent, cache hit rate, Playwright fallback rate, response times (p50/p95), token usage, estimated Claude cost.

## Guardrails

- Never install Express 5 — breaks x402 middleware
- Always return valid JSON from /extract — agents depend on consistent schema
- Keep extraction prompts in INTENT_PROMPTS object in extract.js — single source of truth
- Content truncated to 12k chars — prevents context window blowout on Claude calls
- Batch limited to 5 URLs — cost control at $0.25/batch
- Cache database (cache.db) is gitignored — ephemeral, recreated on startup

## Known limitations

- **Amazon, LinkedIn** — block Railway's datacenter IPs. Works locally with stealth Playwright but not in production. Needs residential proxy support (planned).
- **Reddit** — blocks Playwright but JSON API bypass works. Only gets first page of results (no pagination).
- **SPAs with infinite scroll** — Playwright only captures initially rendered content.

## Phase 2: /valuate endpoint

Product valuation API at $0.10/call. Takes a product description, returns resale estimates. This connects to the home inventory app (separate project). Architecture TBD but likely:
- Input: { product: string, condition: string, photos?: string[] }
- Output: { estimated_value: { low, mid, high }, channels: [...], comparables: [...] }
- Data sources: eBay sold listings (scrape), Facebook Marketplace signals, depreciation models

## Phase 3: Vietnam market intelligence

Endpoints for Vietnamese business data once Michael is on the ground. TBD.
