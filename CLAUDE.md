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
- `TOTAL_BATCHES` is calculated dynamically from the merged list length (not hardcoded)
- Batch rotation: state persisted in `batch_state` Supabase table, advances after each run
- Per-country loop: each marketplace fetched separately (ratings differ per Amazon domain)
- Partial failure resilience: if Keepa fails mid-country, existing DB rows are preserved

**`src/asins.ts`** — base ASIN list (385 hardcoded). Key exports:
- `PROD_ASINS` — full array, used by main.ts to build the merged list
- `TOTAL_BATCHES` — static constant (8), used only as fallback in override mode
- `getAsinBatchFromList(list, batchNum, size)` — batch slice from any list, with wraparound; used in normal rotation
- `getAsinBatch(batchNum, size)` — legacy version that operates on `PROD_ASINS` directly

**`src/keepa-client.ts`** — all Keepa API calls. Keepa domain codes: ES=9, FR=4, IT=8, DE=3. Prices stored as cents (÷100 for display). Ratings stored ×10 by Keepa (÷10 for display). Batches 100 ASINs per API call. Each full run (~50 ASINs × 4 countries + ratings) costs ~920 tokens.

**`src/supabase-client.ts`** — Supabase REST client. `upsertProductos` excludes the `rating` field (managed exclusively by `upsertRatings` to avoid overwriting with null). Composite PK is `(asin, pais)`.

**Supabase tables**:
| Table | Purpose |
|---|---|
| `productos` | Main data, PK: (asin, pais) |
| `batch_state` | Single row tracking current batch number |
| `categorias_cache` | Category names, 24h TTL |
| `vendedores_cache` | Seller display names, permanent |
| `user_favorites` | Per-user favorite ASINs (username → array) |
| `custom_asins` | ASINs added via dashboard Excel upload |
| `disabled_asins` | ASINs removed via dashboard delete button |

**`index.html`** — everything in one file: CSS, HTML, JS. Key globals:
- `activeFilters` (Set) — button filters (fba/fbm/win/lose/changed/fav); empty = show all
- `msState` — multi-select state for país and marca dropdowns; `selected` empty = show all
- `applyFilters()` — re-runs all filters and re-renders the table
- Dashboard default filters (FBA + Vulkkano brand) are set in `loadData()` after `updateSelects()` runs
- `deleteAsin(asin, event)` — removes ASIN from `disabled_asins` + `productos` + `custom_asins`, updates view; only available to logged-in users
- `processAsinFile()` — parses uploaded Excel/CSV (SheetJS CDN), inserts new ASINs into `custom_asins`; SheetJS loaded at bottom of body, not in `<head>`

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

Local: add to `.env`. Production: add to GitHub Secrets (Actions uses these).
