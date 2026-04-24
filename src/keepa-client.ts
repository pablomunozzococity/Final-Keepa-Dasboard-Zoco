const KEEPA_BASE = "https://api.keepa.com";
const IMAGE_BASE = "https://m.media-amazon.com/images/I/";

// Keepa csv price type indices (used in stats.current[], stats.min[], stats.atIntervalStart[])
// 18 = BUY_BOX_SHIPPING: buy box price including shipping (new)
// 10 = NEW_FBA: lowest new FBA offer price
const BUY_BOX_IDX = 18;

type KeepaStats = {
  current: (number | null)[];
  atIntervalStart: (number | null)[] | null;
  min: ([number, number] | null)[];   // 2D: [keepaTime, value]
  // Direct buybox fields — available when buybox=1 parameter is used
  buyBoxSellerId?: string | null;
  buyBoxPrice?: number | null;        // buy box price in cents, -1/-2 if none
  buyBoxShipping?: number | null;     // shipping cost in cents, -1/-2 if none
  buyBoxIsFBA?: boolean | null;
};

type KeepaImage = { m?: string; l?: string };

type KeepaPromotion = {
  type?: number;       // deal type code from Keepa
  freeShipping?: boolean;
  percentageOff?: number;
  fixedOff?: number;
  eligibleMembershipPrograms?: number[];
};

type KeepaProduct = {
  asin: string;
  title?: string;
  brand?: string;
  imagesCSV?: string;
  images?: KeepaImage[];
  // csv[4] = LIGHTNING_DEAL price, csv[16] = RATING (×10), csv[17] = COUNT_REVIEWS
  // csv[16]/csv[17] require &rating=1. csv[4] is populated in standard requests.
  csv?: (number[] | null)[];
  promotions?: KeepaPromotion[] | null;
  salesRanks?: Record<string, number[]> | null;
  salesRankReference?: number | null;
  categoryTree?: { catId: number; name: string }[] | null;
  stats?: KeepaStats;
};

type KeepaResponse = {
  products: KeepaProduct[];
  tokensLeft: number;
};

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
  img_url: string;
  tenemos: boolean;
  hay_buybox: boolean;
  rating: number | null;
  oferta: string | null;
  ranking_subcategoria: number | null;
  categoria_id: number | null;
  categoria_nombre: string | null;
  ranking_pct: number | null;
  vendedor_nombre: string | null;
  updated_at: string;
};

const MAX_REASONABLE_PRICE = 500000; // €5000 — filters Keepa data corruption

const DEAL_LABELS_BY_PAIS: Record<string, Record<number, string>> = {
  ES: { 2: "Oferta flash",  4: "Oferta del día",     8: "Prime Exclusive", 16: "Prime Day", 32: "Black Friday" },
  FR: { 2: "Vente flash",   4: "Offre du jour",       8: "Prime Exclusive", 16: "Prime Day", 32: "Black Friday" },
  IT: { 2: "Offerta lampo", 4: "Offerta del giorno",  8: "Prime Exclusive", 16: "Prime Day", 32: "Black Friday" },
  DE: { 2: "Blitzangebot",  4: "Tagesangebot",        8: "Prime Exclusive", 16: "Prime Day", 32: "Black Friday" },
};
const OFERTA_ACTIVA: Record<string, string> = {
  ES: "Oferta activa", FR: "Offre active", IT: "Offerta attiva", DE: "Aktives Angebot",
};

function keepaPrice(raw: number | null | undefined): number | null {
  if (raw == null || raw <= 0) return null;
  if (raw > MAX_REASONABLE_PRICE) return null;
  return Math.round(raw) / 100;
}

function calcCambio(
  current: number | null | undefined,
  start: number | null | undefined
): number | null {
  if (current == null || current <= 0) return null;
  if (start == null || start <= 0) return null;
  return Math.round(((current - start) / start) * 10000) / 100;
}

function extractImgUrl(imagesCSV: string | undefined, images: KeepaImage[] | undefined, asin: string): string {
  if (images && images.length > 0) {
    const code = images[0].m ?? images[0].l;
    if (code) return `${IMAGE_BASE}${code}`;
  }
  if (imagesCSV) {
    const first = imagesCSV.split(",")[0]?.trim();
    if (first) {
      if (first.startsWith("http")) return first;
      return `${IMAGE_BASE}${first}`;
    }
  }
  return `https://m.media-amazon.com/images/P/${asin}.01._SX300_.jpg`;
}

// csv[16] = RATING history (flat pairs: [keepaTime, value, ...])
// Keepa stores rating × 10, e.g. 4.7 stars → 47. Requires &rating=1 in the request.
function extractRating(csv: (number[] | null)[] | null | undefined): number | null {
  if (!csv) return null;
  const arr = csv[16];
  if (!arr || arr.length < 2) return null;
  const raw = arr[arr.length - 1]; // last value in the time-value flat array
  return raw != null && raw > 0 ? raw / 10 : null;
}

function extractRanking(
  salesRanks: Record<string, number[]> | null | undefined,
  salesRankReference: number | null | undefined
): { rank: number | null; catId: number | null } {
  if (!salesRanks) return { rank: null, catId: null };

  let catKey: string | null = null;
  if (salesRankReference && salesRanks[String(salesRankReference)]) {
    catKey = String(salesRankReference);
  } else {
    catKey = Object.keys(salesRanks)[0] ?? null;
  }

  if (!catKey) return { rank: null, catId: null };

  const entry = salesRanks[catKey];
  if (!entry || entry.length < 2) return { rank: null, catId: null };

  const rank = entry[entry.length - 1];
  return {
    rank: rank > 0 ? rank : null,
    catId: parseInt(catKey),
  };
}

function extractCategoriaNombre(
  categoryTree: { catId: number; name: string }[] | null | undefined,
  catId: number | null
): string | null {
  if (!categoryTree || categoryTree.length === 0) return null;
  if (catId) {
    const found = categoryTree.find((c) => c.catId === catId);
    if (found) return found.name;
  }
  return categoryTree[categoryTree.length - 1]?.name ?? null;
}

function mapProduct(
  p: KeepaProduct,
  pais: string,
  miVendedorId: string
): ProductoRecord {
  // Use direct buyBoxPrice field (requires buybox=1) — most accurate source
  const rawPrecio = (p.stats?.buyBoxPrice != null && p.stats?.buyBoxPrice > 0)
    ? p.stats?.buyBoxPrice
    : null;

  // min is a 2D array [keepaTime, value] — take index 1 for the actual price value
  const rawMin = p.stats?.min?.[BUY_BOX_IDX]?.[1] ?? null;

  // atIntervalStart[18] = buy box price at start of the 90-day stats window
  const rawStart = p.stats?.atIntervalStart?.[BUY_BOX_IDX] ?? null;

  const precio    = keepaPrice(rawPrecio);
  const precio_min = keepaPrice(rawMin);
  const cambio_1d  = calcCambio(rawPrecio, rawStart);

  const buyBoxSellerId = p.stats?.buyBoxSellerId;
  const hay_buybox = !!(buyBoxSellerId && buyBoxSellerId !== "-1") || precio !== null;
  const tenemos = hay_buybox && buyBoxSellerId === miVendedorId;

  const rating = extractRating(p.csv);

  // Deal badge: Lightning Deal (csv[4] last value > 0 means currently active — Keepa ends it
  // by appending a -1 entry; no trailing -1 = deal is still live) or active promotion type.
  // Keepa promotion type codes: 2=Lightning Deal, 4=Deal of the Day, 8=Prime Exclusive,
  // 16=Prime Day, 32=Black Friday/Cyber Monday. Type 1=coupon (excluded — not a badge deal).
  const dealLabels = DEAL_LABELS_BY_PAIS[pais] ?? DEAL_LABELS_BY_PAIS.ES;
  let oferta: string | null = null;
  const lightningArr = p.csv?.[4];
  if (lightningArr && lightningArr.length >= 2) {
    const lastPrice = lightningArr[lightningArr.length - 1];
    // If the last value is positive there is no closing -1 yet → deal is active right now
    if (lastPrice > 0) {
      oferta = dealLabels[2] ?? "Oferta flash";
    }
  }
  if (!oferta && p.promotions && p.promotions.length > 0) {
    const promo = p.promotions.find(pr => pr.type != null && pr.type !== 1);
    if (promo?.type != null) {
      oferta = dealLabels[promo.type] ?? (OFERTA_ACTIVA[pais] ?? "Oferta activa");
    }
  }

  const { rank, catId } = extractRanking(p.salesRanks, p.salesRankReference);
  const categoria_nombre = extractCategoriaNombre(p.categoryTree, catId);

  return {
    asin: p.asin,
    pais,
    titulo: p.title ?? "",
    marca: p.brand ?? "",
    precio,
    precio_min,
    cambio_1d,
    es_fba: p.stats?.buyBoxIsFBA ?? null,
    vendedor: buyBoxSellerId && buyBoxSellerId !== "-1" ? buyBoxSellerId : null,
    img_url: extractImgUrl(p.imagesCSV, p.images, p.asin),
    tenemos,
    hay_buybox,
    rating,
    oferta,
    ranking_subcategoria: rank,
    categoria_id: catId,
    categoria_nombre,
    ranking_pct: null,      // calculated in main.ts after category lookup
    vendedor_nombre: null,  // resolved in main.ts after seller lookup
    updated_at: new Date().toISOString(),
  };
}

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
      const delay = Math.pow(2, attempt) * 5000;
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

const MIN_TOKENS_THRESHOLD = 100;

export type FetchResult = {
  records: ProductoRecord[];
  tokensLeft: number;
  stoppedEarly: boolean;
};

export async function fetchKeepaProducts(
  asins: string[],
  domain: number,
  pais: string,
  keepaKey: string,
  miVendedorId: string
): Promise<FetchResult> {
  const BATCH_SIZE = 100;
  const records: ProductoRecord[] = [];
  let tokensLeft = Infinity;

  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    if (tokensLeft < MIN_TOKENS_THRESHOLD) {
      console.warn(
        `  [${pais}] ⚠ Solo quedan ${tokensLeft} tokens — deteniendo para no agotar el límite`
      );
      return { records, tokensLeft, stoppedEarly: true };
    }

    const batch = asins.slice(i, i + BATCH_SIZE);
    const asinParam = batch.join(",");
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${keepaKey}` +
      `&domain=${domain}` +
      `&asin=${asinParam}` +
      `&stats=1` +
      `&buybox=1`;

    console.log(
      `  [${pais}] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} ASINs (tokens disponibles: ${tokensLeft === Infinity ? "?" : tokensLeft})`
    );

    const data = await fetchWithRetry(url);
    tokensLeft = data.tokensLeft;

    console.log(
      `  [${pais}] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${data.products?.length ?? 0} productos recibidos, tokens restantes: ${tokensLeft}`
    );

    for (const p of data.products ?? []) {
      records.push(mapProduct(p, pais, miVendedorId));
    }
  }

  return { records, tokensLeft, stoppedEarly: false };
}

// Fetches only ratings (csv[16]) using &rating=1 without stats/buybox.
// Much cheaper token profile — use in a separate run to avoid exhausting the budget.
export async function fetchKeepaRatings(
  asins: string[],
  domain: number,
  pais: string,
  keepaKey: string
): Promise<Map<string, number | null>> {
  const BATCH_SIZE = 100;
  const ratings = new Map<string, number | null>();
  let tokensLeft = Infinity;

  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    if (tokensLeft < MIN_TOKENS_THRESHOLD) {
      console.warn(`  [${pais}] ratings ⚠ Solo quedan ${tokensLeft} tokens — deteniendo`);
      break;
    }
    const batch = asins.slice(i, i + BATCH_SIZE);
    const url =
      `${KEEPA_BASE}/product` +
      `?key=${keepaKey}` +
      `&domain=${domain}` +
      `&asin=${batch.join(",")}` +
      `&rating=1`;

    console.log(`  [${pais}] ratings batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} ASINs`);
    const data = await fetchWithRetry(url);
    tokensLeft = data.tokensLeft;
    console.log(`  [${pais}] ratings batch ${Math.floor(i / BATCH_SIZE) + 1}: tokens restantes: ${tokensLeft}`);

    for (const p of data.products ?? []) {
      ratings.set(p.asin, extractRating(p.csv));
    }
  }

  return ratings;
}
