import "dotenv/config";
import { ASINS } from "./asins.js";
import { fetchKeepaProducts } from "./keepa-client.js";
import { fetchCategoryInfo } from "./category-client.js";
import { fetchSellerNames } from "./seller-client.js";
import {
  upsertProductos,
  getCachedCategories,
  upsertCategorias,
  getCachedSellers,
  upsertVendedores,
} from "./supabase-client.js";

type CountryConfig = {
  code: string;
  domain: number; // Keepa domain codes: ES=8, FR=4, IT=10, DE=3
};

const COUNTRIES: CountryConfig[] = [
  { code: "ES", domain: 8 },
  { code: "FR", domain: 4 },
  { code: "IT", domain: 10 },
  { code: "DE", domain: 3 },
];

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

  console.log(
    `Iniciando actualización: ${ASINS.length} ASINs × ${COUNTRIES.length} países → tabla: ${supabaseTable}`
  );

  // Step 1: Fetch all products from Keepa
  const allProductos = [];
  for (const country of COUNTRIES) {
    console.log(`\n=== ${country.code} (domain ${country.domain}) ===`);
    try {
      const productos = await fetchKeepaProducts(
        ASINS,
        country.domain,
        country.code,
        keepaKey,
        miVendedorId
      );
      console.log(`  ${country.code}: ${productos.length} productos obtenidos`);
      allProductos.push(...productos);
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
      const country = COUNTRIES.find((c) => c.code === p.pais);
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
  const uniqueSellerIds = [
    ...new Set(
      allProductos
        .map((p) => p.vendedor)
        .filter((v): v is string => !!v && v !== "-1")
    ),
  ];
  console.log(`\nVendedores únicos a resolver: ${uniqueSellerIds.length}`);

  const sellerCache = await getCachedSellers(uniqueSellerIds, supabaseUrl, supabaseKey);

  const missingSellers = uniqueSellerIds.filter((id) => !sellerCache.has(id));
  if (missingSellers.length > 0) {
    // Fetch missing sellers — use ES domain (8) as reference for name lookup
    const newNames = await fetchSellerNames(missingSellers, 8, keepaKey);
    for (const [id, name] of newNames) {
      sellerCache.set(id, name);
    }
    await upsertVendedores(
      [...newNames.entries()].map(([sellerId, nombre]) => ({ sellerId, nombre })),
      supabaseUrl,
      supabaseKey
    );
    console.log(`  ${newNames.size} vendedores guardados en caché`);
  }

  // Apply seller names to products
  for (const p of allProductos) {
    if (p.vendedor) {
      p.vendedor_nombre = sellerCache.get(p.vendedor) ?? null;
    }
  }

  // Step 8: Upsert all products to Supabase
  console.log(`\nSubiendo ${allProductos.length} filas a Supabase...`);
  const { count } = await upsertProductos(
    allProductos,
    supabaseUrl,
    supabaseKey,
    supabaseTable
  );

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Total filas upserted: ${count}`);
  console.log("Completado correctamente.");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
