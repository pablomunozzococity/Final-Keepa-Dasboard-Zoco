# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Amazon BuyBox monitor for Zococity. Tracks ~385 ASINs (plus any manually added) across 4 EU marketplaces (ES, FR, IT, DE).

- **Data pipeline**: TypeScript scripts run via GitHub Actions `workflow_dispatch` — triggered every 30 min by cron-job.org (external scheduler), stores in Supabase
- **Dashboard**: `index.html` — single-file client-side app served via GitHub Pages, reads Supabase REST directly
- **No framework, no bundler, no tests** — `tsx` runs TypeScript source directly

## Commands

```bash
npm start        # run pipeline locally (reads .env)
npm run dev      # same, with tsx watch mode
```

No lint or test commands configured.

## Deploy

- **Pipeline**: push to `main` → GitHub Actions responds to `workflow_dispatch`. The schedule trigger was removed; cron-job.org fires it every 30 min via the GitHub API.
- **Dashboard**: edit `index.html`, commit, push → GitHub Pages updates in ~2 minutes.

### Manual pipeline trigger (GitHub Actions UI or API)

The `workflow_dispatch` accepts these optional inputs (all map to env vars of the same name):

| Input | Default | Effect |
|---|---|---|
| `asins_override` | `` | Fixed comma-separated ASINs — skips batch rotation |
| `batch_size` | `50` | ASINs per rotation batch |
| `clear_table` | `false` | `true` wipes the table before loading |
| `run_mode` | `buybox` | `ratings` for a cheap ratings-only run |

## Architecture

```
cron-job.org (every 30 min)
  └─ POST GitHub API → workflow_dispatch → GitHub Actions
       └─ npm start → src/main.ts
            ├─ keepa-client.ts    fetch products + ratings from Keepa API
            ├─ category-client.ts resolve category names (cached 24h in Supabase)
            ├─ seller-client.ts   resolve seller display names (cached permanently)
            └─ supabase-client.ts upsert to Supabase via REST API

GitHub Pages → index.html
  └─ reads Supabase REST API directly (no backend)
```

**`src/main.ts`** — orchestrator. Key decisions made here:
- Token guard at start: exits cleanly if Keepa tokens < 950 (plan generates 21 tokens/min, bucket cap 1260)
- Two run modes: `buybox` (full, expensive) and `ratings` (ratings-only, cheap)
- Dynamic ASIN list: merges `asins.ts` base list + `custom_asins` table − `disabled_asins` table on every run
- `dynamicTotalBatches` is calculated from the merged list length (not hardcoded)
- Batch rotation: state persisted in `batch_state` Supabase table, advances after each run
- Per-country loop: each marketplace fetched separately (ratings differ per Amazon domain)
- Partial failure resilience: if Keepa fails mid-country, existing DB rows are preserved
- Upsert split: products with a non-empty title → `upsertProductos` (full). Products without title → `upsertBuyboxOnly` only if a titulo row already exists; otherwise the skeleton row is deleted via `deleteProductosByAsins`

**`src/asins.ts`** — base ASIN list (385 hardcoded). Key exports:
- `PROD_ASINS` — full array, used by main.ts to build the merged list
- `TOTAL_BATCHES` — static constant (8), used only as fallback in override mode
- `getAsinBatchFromList(list, batchNum, size)` — batch slice from any list, with wraparound; used in normal rotation
- `getAsinBatch(batchNum, size)` — legacy version that operates on `PROD_ASINS` directly

**`src/keepa-client.ts`** — all Keepa API calls. Keepa domain codes: ES=9, FR=4, IT=8, DE=3. Prices stored as cents (÷100 for display). Ratings stored ×10 by Keepa (÷10 for display). Batches 100 ASINs per API call (internal, separate from the 50-ASIN rotation batch). Each full run (~50 ASINs × 4 countries + ratings) costs ~920 tokens. If tokens drop below 100 mid-run, stops early and returns `stoppedEarly: true` — distinct from the 950-token guard in `main.ts` that skips the run entirely. Retries on HTTP 429 with exponential backoff (5s × 2^attempt, up to 3 retries).

**`src/category-client.ts`** — fetches category metadata from Keepa `/category` endpoint. Uses `productCount ?? highestRank ?? 0` as the total product count for `ranking_pct` calculations. Returns `null` on failure (non-fatal).

**`src/seller-client.ts`** — fetches seller display names from Keepa `/seller` endpoint. Each seller is fetched in the domain where it was first seen, for name accuracy. Returns only sellers that Keepa has a name for; missing sellers stay as raw IDs.

**`src/supabase-client.ts`** — Supabase REST client. Three upsert functions:
- `upsertProductos` — full upsert, excludes `rating` field (managed exclusively by `upsertRatings` to avoid overwriting with null). Composite PK is `(asin, pais)`.
- `upsertBuyboxOnly` — partial upsert, only updates buybox/price fields, never touches `titulo`/`marca`/`img_url`. Used when Keepa returns a product without a title (ASIN not listed in that marketplace).
- `upsertRatings` — writes only the `rating` field.
Also contains `getViolations()`, `getLastAlertSent()`, `setLastAlertSent()` for the exclusive-brand alert system.

**`src/exclusive-brands.ts`** — pure config (no I/O). Key exports:
- `ALERT_EXCLUDED_ASINS` — ASINs that never trigger alert emails regardless of brand rules. Edit this Set to silence specific ASINs.
- `EDIFIER_ES_ASINS` — specific Edifier ASINs monitored exclusively in ES.
- `ES_ONLY_BRANDS` (fiio, eversolo) — exclusive brands for ES only.
- `ALL_EU_BRANDS` (vulkkano, hiby) — exclusive brands for all 4 markets.
- `isExclusiveBrand(asin, marca, pais)` — single entry point; returns false immediately if ASIN is in `ALERT_EXCLUDED_ASINS`.

**`src/alert-client.ts`** — sends violation alert emails via Resend REST API (no npm package, native fetch). `sendViolationAlert(violations, resendApiKey, recipient)` returns `{ ok: true, id }` or `{ ok: false, error }` — never throws, so email failures never abort the pipeline.

**Supabase tables**:
| Table | Purpose |
|---|---|
| `productos` | Main data, PK: (asin, pais) |
| `batch_state` | Key-value store: `current_batch` (int) + `last_alert_sent` (Unix ms timestamp) |
| `categorias_cache` | Category names, 24h TTL |
| `vendedores_cache` | Seller display names, permanent |
| `user_favorites` | Per-user favorite ASINs (username → array) |
| `custom_asins` | ASINs added via dashboard Excel upload |
| `disabled_asins` | ASINs removed via dashboard delete button |

**Ratings in buybox mode** — `buybox` mode (the default) fetches ratings inline as step 7b in `main.ts`, writing them via `upsertRatings` right after product upserts. The separate `ratings` RUN_MODE exists as a cheaper dedicated run (uses `&rating=1` only, no `&stats=1&buybox=1`) for cases where you want to refresh ratings without spending buybox tokens.

**Exclusive-brand alert system** — triggers on every round completion (`nextBatch === 1` after batch advance, ~every 4 hours):
- Queries `productos` for rows where `hay_buybox=true AND tenemos=false`, filters by `isExclusiveBrand`
- Throttled to once per UTC day via `last_alert_sent` in `batch_state`. **Important**: `setLastAlertSent` is called even when there are 0 violations — so once the first round of the day completes, subsequent rounds that day are skipped regardless of new violations appearing.
- Requires `RESEND_API_KEY` env var; degrades gracefully (logs warning) if missing
- Alert recipient is hardcoded to `pablo.munoz@zococity.com` in `main.ts`

**`index.html`** — everything in one file: CSS, HTML, JS. Key globals:
- `activeFilters` (Set) — button filters (fba/fbm/win/lose/changed/fav); empty = show all
- `msState` — multi-select state for país and marca dropdowns; `selected` empty = show all
- `applyFilters()` — re-runs all filters and re-renders the table
- Dashboard default filters (FBA + Vulkkano brand) are set in `loadData()` after `updateSelects()` runs
- `deleteAsin(asin, event)` — removes ASIN from `disabled_asins` + `productos` + `custom_asins`, updates view; only available to logged-in users
- `processAsinFile()` — parses uploaded Excel/CSV (SheetJS CDN), inserts into `custom_asins` **and removes from `disabled_asins`** (so re-adding a previously deleted ASIN works correctly); SheetJS loaded at bottom of body, not in `<head>`

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `KEEPA_API_KEY` | Yes | Keepa API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase service role key |
| `MI_VENDEDOR_ID` | Yes | Our Amazon seller ID (to detect if we hold buybox) |
| `SUPABASE_TABLE` | No | Table name, default `productos` |
| `RUN_MODE` | No | `buybox` (default) or `ratings` |
| `RUN_NUMBER` | No | 1-4 to process one country only (1=ES,2=FR,3=IT,4=DE) |
| `ASINS_OVERRIDE` | No | Comma-separated ASINs for test runs (skips batch rotation and dynamic ASIN merge) |
| `BATCH_SIZE` | No | ASINs per batch, default 50 |
| `CLEAR_TABLE` | No | `true` to wipe table before loading (test only) |
| `RESEND_API_KEY` | No | Resend API key for exclusive-brand violation emails |

Local: add to `.env`. Production: add to GitHub Secrets (Actions uses these).
