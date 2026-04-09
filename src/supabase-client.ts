import type { ProductoRecord } from "./keepa-client.js";

const BATCH_SIZE = 500; // Supabase default row limit per request

/**
 * Upserts an array of ProductoRecord into the specified Supabase table.
 * Uses on_conflict=asin,pais so existing rows are updated, not duplicated.
 * Pass table="productos_test" for testing, "productos" for production.
 * Returns the total number of rows processed.
 */
export async function upsertProductos(
  productos: ProductoRecord[],
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<{ count: number }> {
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=merge-duplicates",
  };

  let totalCount = 0;

  for (let i = 0; i < productos.length; i += BATCH_SIZE) {
    const batch = productos.slice(i, i + BATCH_SIZE);

    const res = await fetch(
      `${supabaseUrl}/rest/v1/${table}?on_conflict=asin,pais`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Supabase upsert failed: ${res.status} ${text.slice(0, 300)}`
      );
    }

    totalCount += batch.length;
  }

  return { count: totalCount };
}
