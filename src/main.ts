import "dotenv/config";
import { getAsins } from "./asins.js";
import { fetchKeepaProducts, fetchKeepaRatings } from "./keepa-client.js";
import { fetchCategoryInfo } from "./category-client.js";
import { fetchSellerNames } from "./seller-client.js";
import {
  upsertProductos,
  upsertBuyboxOnly,
  upsertRatings,
  getCachedCategories,
  upsertCategorias,
  getCachedSellers,
  upsertVendedores,
  getAsinsWithTitulo,
  deleteProductosByAsins,
} from "./supabase-client.js";

type CountryConfig = {
  code: string;
  domain: number; // Keepa domain codes: ES=9, FR=4, IT=8, DE=3
};

const ALL_COUNTRIES: CountryConfig[] = [
  { code: "ES", domain: 9 },
  { code: "FR", domain: 4 },
  { code: "IT", domain: 8 },
  { code: "DE", domain: 3 },
];

// RUN_NUMBER → país a procesar en cada run (todos los ASINs, 1 país por hora)
const RUN_CONFIG: Record<number, string> = {
  1: "ES",
  2: "FR",
  3: "IT",
  4: "DE",
};

async function main() {
  const keepaKey = process.env.KEEPA_API_KEY;
  if (!keepaKey) throw new Error("KEEPA_API_KEY is not set");

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) throw new Error("SUPABASE_URL is not set");

  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseKey) throw new Error("SUPABASE_KEY is not set");

  const miVendedorId = process.env.MI_VENDEDOR_ID;
  if (!miVendedorId) throw new Error("MI_VENDEDOR_ID is not set");

  const supabaseTable = process.env.SUPABASE_TABLE ?? "productos";
  const runMode    = process.env.RUN_MODE ?? "buybox"; // "buybox" | "ratings"
  const runNumber  = process.env.RUN_NUMBER ? parseInt(process.env.RUN_NUMBER) : undefined;
  const countryCode = runNumber ? RUN_CONFIG[runNumber] : undefined;
  const COUNTRIES = countryCode
    ? ALL_COUNTRIES.filter((c) => c.code === countryCode)
    : ALL_COUNTRIES;
  const ASINS = getAsins();

  // ── RATINGS MODE: rating is product-level (same across all marketplaces).
  // Fetch once from ES domain, write to the selected countries. ~150 tokens total.
  // RUN_NUMBER selects which countries to write to (empty = all).
  if (runMode === "ratings") {
    const esDomain = ALL_COUNTRIES.find(c => c.code === "ES")!;
    const targetCountries = COUNTRIES; // respects RUN_NUMBER
    console.log(`Modo ratings: ${ASINS.length} ASINs (fetch desde ES → escribe a [${targetCountries.map(c => c.code).join(", ")}])`);
    const ratingMap = await fetchKeepaRatings(ASINS, esDomain.domain, "ES", keepaKey);
    const found = [...ratingMap.values()].filter(v => v !== null).length;
    console.log(`  Ratings obtenidos: ${found}/${ASINS.length}`);
    for (const country of targetCountries) {
      // Only write ratings for ASINs that already have a product row with titulo.
      // Avoids creating skeleton rows for countries without BuyBox data yet.
      const existing = await getAsinsWithTitulo(ASINS, country.code, supabaseUrl, supabaseKey, supabaseTable);
      if (existing.size === 0) {
        console.log(`  ${country.code}: sin filas de producto — saltado`);
        continue;
      }
      const rows = ASINS
        .filter(asin => existing.has(asin))
        .map(asin => ({ asin, pais: country.code, rating: ratingMap.get(asin) ?? null }));
      await upsertRatings(rows, supabaseUrl, supabaseKey, supabaseTable);
      console.log(`  ${country.code}: ${rows.length} ratings guardados`);
    }
    console.log("\nRatings completados.");
    return;
  }

  console.log(
    `Iniciando actualización: run=${runNumber ?? "todos"} → ${ASINS.length} ASINs × [${COUNTRIES.map(c => c.code).join(", ")}] → tabla: ${supabaseTable}`
  );

  // Step 1: Fetch all products from Keepa, then replace country data in Supabase
  // Fetch first — if Keepa fails, existing data is preserved.
  // Only delete + insert when the fetch succeeds (even if partial).
  const allProductos = [];
  for (const country of COUNTRIES) {
    console.log(`\n=== ${country.code} (domain ${country.domain}) ===`);
    try {
      const result = await fetchKeepaProducts(
        ASINS,
        country.domain,
        country.code,
        keepaKey,
        miVendedorId
      );

      if (result.records.length === 0) {
        console.warn(`  ${country.code}: sin productos — omitiendo reemplazo en Supabase`);
        continue;
      }

      if (result.stoppedEarly) {
        console.warn(
          `  ${country.code}: run parcial (${result.records.length}/${ASINS.length} productos) por tokens insuficientes — guardando lo obtenido, el resto conserva datos anteriores`
        );
      } else {
        console.log(`  ${country.code}: ${result.records.length} productos obtenidos`);
      }
      allProductos.push(...result.records);
    } catch (err) {
      console.error(
        `  ${country.code} FALLÓ: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Step 2: Collect unique (catId, domain) pairs that have a rank
  const pairs: { catId: number; domain: string; domainNum: number }[] = [];
  for (const p of allProductos) {
    if (p.categoria_id && p.ranking_subcategoria) {
      const country = ALL_COUNTRIES.find((c) => c.code === p.pais);
      if (
        country &&
        !pairs.find((x) => x.catId === p.categoria_id && x.domain === p.pais)
      ) {
        pairs.push({ catId: p.categoria_id, domain: p.pais, domainNum: country.domain });
      }
    }
  }

  console.log(`\nCategorías únicas a resolver: ${pairs.length}`);

  // Step 3: Check Supabase cache (valid for 24h)
  const cached = await getCachedCategories(
    pairs.map((p) => ({ catId: p.catId, domain: p.domain })),
    supabaseUrl,
    supabaseKey
  );

  // Step 4: Fetch missing categories from Keepa
  const newCats = [];
  for (const pair of pairs) {
    const key = `${pair.catId}:${pair.domain}`;
    if (!cached.has(key)) {
      console.log(`  Fetching category ${pair.catId} for ${pair.domain}...`);
      const info = await fetchCategoryInfo(
        pair.catId,
        pair.domainNum,
        pair.domain,
        keepaKey
      );
      if (info) {
        cached.set(key, info);
        newCats.push(info);
      }
    }
  }

  // Step 5: Store new categories in cache
  if (newCats.length > 0) {
    await upsertCategorias(newCats, supabaseUrl, supabaseKey);
    console.log(`  ${newCats.length} categorías guardadas en caché`);
  }

  // Step 6: Calculate ranking_pct for each product
  for (const p of allProductos) {
    if (p.categoria_id && p.ranking_subcategoria) {
      const key = `${p.categoria_id}:${p.pais}`;
      const cat = cached.get(key);
      if (cat && cat.total > 0) {
        p.ranking_pct = Math.round((p.ranking_subcategoria / cat.total) * 10000) / 100;
      }
    }
  }

  // Step 7: Resolve seller names
  // Collect unique seller IDs with their domain for lookup
  const sellerDomainMap = new Map<string, number>(); // sellerId → domain number
  for (const p of allProductos) {
    if (p.vendedor && p.vendedor !== "-1") {
      const country = ALL_COUNTRIES.find((c) => c.code === p.pais);
      if (country && !sellerDomainMap.has(p.vendedor)) {
        sellerDomainMap.set(p.vendedor, country.domain);
      }
    }
  }
  const uniqueSellerIds = [...sellerDomainMap.keys()];
  console.log(`\nVendedores únicos a resolver: ${uniqueSellerIds.length}`);

  const sellerCache = await getCachedSellers(uniqueSellerIds, supabaseUrl, supabaseKey);

  const missingSellers = uniqueSellerIds.filter((id) => !sellerCache.has(id));
  if (missingSellers.length > 0) {
    const newVendedores: { sellerId: string; nombre: string }[] = [];
    // Fetch each missing seller in its own domain for best name accuracy
    for (const sellerId of missingSellers) {
      const domain = sellerDomainMap.get(sellerId) ?? 8;
      const names = await fetchSellerNames([sellerId], domain, keepaKey);
      const name = names.get(sellerId);
      if (name) {
        sellerCache.set(sellerId, name);
        newVendedores.push({ sellerId, nombre: name });
      }
    }
    await upsertVendedores(newVendedores, supabaseUrl, supabaseKey);
    console.log(`  ${newVendedores.length} vendedores guardados en caché`);
  }

  // Apply seller names to products
  for (const p of allProductos) {
    if (p.vendedor) {
      p.vendedor_nombre = sellerCache.get(p.vendedor) ?? null;
    }
  }

  // Step 8: Upsert to Supabase.
  // Products WITH title → full upsert (all fields including titulo, marca, img_url).
  // Products WITHOUT title → update only buybox fields, but ONLY for rows that already
  //   have a titulo in the DB. This prevents creating skeleton rows for ASINs that do
  //   not exist in a given marketplace (Keepa returns them with no title).
  const conTitulo    = allProductos.filter(p => p.titulo.trim() !== "");
  const sinTituloArr = allProductos.filter(p => p.titulo.trim() === "");

  console.log(`\nSubiendo ${conTitulo.length} productos completos a Supabase...`);
  const { count: countFull } = await upsertProductos(conTitulo, supabaseUrl, supabaseKey, supabaseTable);

  let countPartial = 0;
  if (sinTituloArr.length > 0) {
    // Group by country, then check which ASINs already have a row with a titulo.
    const byPais = new Map<string, typeof sinTituloArr>();
    for (const p of sinTituloArr) {
      if (!byPais.has(p.pais)) byPais.set(p.pais, []);
      byPais.get(p.pais)!.push(p);
    }
    const toUpdate: typeof sinTituloArr = [];
    const toDelete = new Map<string, string[]>(); // pais → asins to purge
    for (const [pais, prods] of byPais) {
      const existing = await getAsinsWithTitulo(prods.map(p => p.asin), pais, supabaseUrl, supabaseKey, supabaseTable);
      for (const p of prods) {
        if (existing.has(p.asin)) {
          toUpdate.push(p);
        } else {
          if (!toDelete.has(pais)) toDelete.set(pais, []);
          toDelete.get(pais)!.push(p.asin);
        }
      }
    }
    // Delete skeleton rows created by previous runs for ASINs with no marketplace listing
    for (const [pais, asins] of toDelete) {
      await deleteProductosByAsins(asins, pais, supabaseUrl, supabaseKey, supabaseTable);
    }
    const skipped = sinTituloArr.length - toUpdate.length;
    if (skipped > 0) {
      console.log(`\nℹ ${skipped} sin listing en este mercado — filas vacías eliminadas de la BD`);
    }
    if (toUpdate.length > 0) {
      console.log(`\n⚠ ${toUpdate.length} productos sin título de Keepa — actualizando solo buybox en filas existentes`);
      await upsertBuyboxOnly(toUpdate, supabaseUrl, supabaseKey, supabaseTable);
      countPartial = toUpdate.length;
    }
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Total filas actualizadas: ${countFull + countPartial}`);
  console.log("Completado correctamente.");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
