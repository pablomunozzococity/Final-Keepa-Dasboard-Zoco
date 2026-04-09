import "dotenv/config";
import { ASINS } from "./asins.js";
import { fetchKeepaProducts } from "./keepa-client.js";
import { upsertProductos } from "./supabase-client.js";

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

  const results: Record<string, { upserted: number; error: string | null }> =
    {};

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

      const { count } = await upsertProductos(
        productos,
        supabaseUrl,
        supabaseKey,
        supabaseTable
      );
      results[country.code] = { upserted: count, error: null };
      console.log(`  ${country.code}: ${count} filas upserted en Supabase`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[country.code] = { upserted: 0, error: message };
      console.error(`  ${country.code} FALLÓ: ${message}`);
    }
  }

  const totalUpserted = Object.values(results).reduce(
    (sum, r) => sum + r.upserted,
    0
  );
  const failedCountries = Object.entries(results)
    .filter(([, r]) => r.error !== null)
    .map(([code]) => code);

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Total filas upserted: ${totalUpserted}`);
  if (failedCountries.length > 0) {
    console.warn(`Países con error: ${failedCountries.join(", ")}`);
    process.exit(1);
  } else {
    console.log("Todos los países completados correctamente.");
  }
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
