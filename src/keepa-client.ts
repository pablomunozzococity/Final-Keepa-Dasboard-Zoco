// ─────────────────────────────────────────────────────────────────────────────
// Keepa REST API client
// Docs: https://keepa.com/#!api
//
// Domain codes: ES=8, FR=4, IT=10, DE=3
// Prices in Keepa are integers (cents). -1 means "no data / no BuyBox".
// ratings are integers 0–50 (e.g. 43 = 4.3 stars).
// ─────────────────────────────────────────────────────────────────────────────

const KEEPA_BASE = "https://api.keepa.com";
const IMAGE_BASE = "https://images-na.ssl-images-amazon.com/images/I/";

// ── Keepa API response types ──────────────────────────────────────────────────

type KeepaStats = {
  current: (number | null)[];
  min: (number | null)[];
  atIntervalStart: (number | null)[] | null;
};

type KeepaProduct = {
  asin: string;
  title?: string;
  brand?: string;
  imagesCSV?: string;
  buyBoxSellerId?: string | null;
  buyBoxIsFBA?: boolean | null;
  rating?: number;
  promotions?: unknown[] | null;
  salesRanks?: Record<string, number[]> | null;
  stats: KeepaStats;
};

type KeepaResponse = {
  products: KeepaProduct[];
  tokensLeft: number;
};

// ── Output type (matches Supabase productos schema) ───────────────────────────

export type ProductoRecord = {
  asin: string;
  pais: string;
  titulo: string;
  marca: string;
  vendedor: string | null;
  precio: number | null;
  precio_min: number | null;
  cambio_1d: number | null;
  es_fba: boolean | null;
  img_url: string | null;
  tenemos: boolean;
  hay_buybox: boolean;
  rating: number | null;
  oferta: string | null;
  ranking_subcategoria: number | null;
  updated_at: string;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function keepaPrice(raw: number | null | undefined): number | null {
  if (raw == null || raw <= 0) return null;
  return Math.round(raw) / 100;
}

function calcCambio1d(
  current: number | null | undefined,
  start: number | null | undefined
): number | null {
  if (current == null || current <= 0) return null;
  if (start == null || start <= 0) return null;
  return Math.round(((current - start) / start) * 10000) / 100;
}

function extractImgUrl(imagesCSV: string | undefined): string | null {
  if (!imagesCSV) return null;
  const first = imagesCSV.split(",")[0]?.trim();
  if (!first) return null;
  // If Keepa already returns a full URL, use it directly; otherwise prepend base.
  if (first.startsWith("http")) return first;
  return `${IMAGE_BASE}${first}`;
}

function extractRankingSubcategoria(
  salesRanks: Record<string, number[]> | null | undefined
): number | null {
  if (!salesRanks) return null;
  // salesRanks format: { "categoryNodeId": [timestamp, rank, timestamp, rank, ...] }
  // We want the most recent rank from the first (main) category entry.
  const firstEntry = Object.values(salesRanks)[0];
  if (!firstEntry || firstEntry.length < 2) return null;
  // Last element is the most recent rank (alternating ts/rank pairs).
  return firstEntry[firstEntry.length - 1] ?? null;
}

function mapProduct(
  p: KeepaProduct,
  pais: string,
  miVendedorId: string
): ProductoRecord {
  // Index 10 in stats arrays = Buy Box price (inclusive of shipping)
  const rawPrecio = p.stats.current[10];
  const rawMin = p.stats.min[10];
  const rawStart = p.stats.atIntervalStart?.[10];

  const precio = keepaPrice(rawPrecio);
  const precio_min = keepaPrice(rawMin);
  const cambio_1d = calcCambio1d(rawPrecio, rawStart);

  const hay_buybox = precio !== null;
  const tenemos = hay_buybox && p.buyBoxSellerId === miVendedorId;

  const rating =
    typeof p.rating === "number" && p.rating > 0 ? p.rating / 10 : null;

  // oferta: best-effort from promotions
  let oferta: string | null = null;
  if (p.promotions && p.promotions.length > 0) {
    try {
      oferta = JSON.stringify(p.promotions[0]).slice(0, 200);
    } catch {
      oferta = null;
    }
  }

  return {
    asin: p.asin,
    pais,
    titulo: p.title ?? "",
    marca: p.brand ?? "",
    vendedor: p.buyBoxSellerId ?? null,
    precio,
    precio_min,
    cambio_1d,
    es_fba: p.buyBoxIsFBA ?? null,
    img_url: extractImgUrl(p.imagesCSV),
    tenemos,
    hay_buybox,
    rating,
    oferta,
    ranking_subcategoria: extractRankingSubcategoria(p.salesRanks),
    updated_at: new Date().toISOString(),
  };
}

// ── Fetch with retry on 429 ───────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  maxRetries = 3
): Promise<KeepaResponse> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);

    if (res.status === 429) {
      if (attempt === maxRetries) {
        throw new Error("Keepa rate limit: max retries exceeded");
      }
      const delay = Math.pow(2, attempt) * 5000; // 5s, 10s, 20s
      console.warn(
        `Keepa 429 rate limit — waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}`
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Keepa API error: ${res.status} ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<KeepaResponse>;
  }
  throw new Error("fetchWithRetry: unreachable");
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Fetches Keepa product data for all ASINs in a given marketplace domain.
 * ASINs are sent in batches of 100 (Keepa maximum per request).
 * Returns a flat array of ProductoRecord ready for Supabase upsert.
 */
export async function fetchKeepaProducts(
  asins: string[],
  domain: number,
  pais: string,
  keepaKey: string,
  miVendedorId: string
): Promise<ProductoRecord[]> {
  const BATCH_SIZE = 100;
  const records: ProductoRecord[] = [];

  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    const batch = asins.slice(i, i + BATCH_SIZE);
    const asinParam = batch.join(",");
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${keepaKey}` +
      `&domain=${domain}` +
      `&asin=${asinParam}` +
      `&stats=1`;

    console.log(
      `  [${pais}] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} ASINs`
    );

    const data = await fetchWithRetry(url);

    console.log(
      `  [${pais}] batch ${Math.floor(i / BATCH_SIZE) + 1}: received ${data.products?.length ?? 0} products, tokens left: ${data.tokensLeft}`
    );

    for (const p of data.products ?? []) {
      records.push(mapProduct(p, pais, miVendedorId));
    }
  }

  return records;
}
