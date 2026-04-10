import "dotenv/config";
import { getAsins } from "./asins.js";
import { fetchKeepaProducts } from "./keepa-client.js";
import { fetchCategoryInfo } from "./category-client.js";
import { fetchSellerNames } from "./seller-client.js";
import {
  upsertProductos,
  deleteProductosByCountry,
  getCachedCategories,
  upsertCategorias,
  getCachedSellers,
  upsertVendedores,
} from "./supabase-client.js";

type CountryConfig = {
  code: string;
  domain: number; // Keepa domain codes: ES=8, FR=4, IT=10, DE=3
};

const ALL_COUNTRIES: CountryConfig[] = [
  { code: "ES", domain: 8 },
  { code: "FR", domain: 4 },
  { code: "IT", domain: 10 },
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
  const runNumber = process.env.RUN_NUMBER ? parseInt(process.env.RUN_NUMBER) : undefined;
  const countryCode = runNumber ? RUN_CONFIG[runNumber] : undefined;
  const COUNTRIES = countryCode
    ? ALL_COUNTRIES.filter((c) => c.code === countryCode)
    : ALL_COUNTRIES;
  const ASINS = getAsins();

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
          `  ${country.code}: run parcial (${result.records.length} productos) por tokens insuficientes — omitiendo reemplazo para no dejar datos incompletos`
        );
        continue;
      }

      console.log(`  ${country.code}: ${result.records.length} productos obtenidos`);
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

  // Step 8: Replace data in Supabase — delete old rows per country, then insert fresh data
  const paisesActualizados = [...new Set(allProductos.map((p) => p.pais))];
  console.log(`\nReemplazando datos en Supabase para: [${paisesActualizados.join(", ")}]`);

  for (const pais of paisesActualizados) {
    console.log(`  Eliminando filas antiguas de ${pais}...`);
    await deleteProductosByCountry(pais, supabaseUrl, supabaseKey, supabaseTable);
  }

  console.log(`  Insertando ${allProductos.length} filas nuevas...`);
  const { count } = await upsertProductos(
    allProductos,
    supabaseUrl,
    supabaseKey,
    supabaseTable
  );

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Total filas insertadas: ${count}`);
  console.log("Completado correctamente.");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
