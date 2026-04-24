import type { ProductoRecord } from "./keepa-client.js";
import type { CategoryInfo } from "./category-client.js";

const BATCH_SIZE = 500;

// Full upsert — all fields including titulo, marca, img_url.
// Use for products where Keepa returned a non-empty title.
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
    // Exclude `rating` — ratings are managed exclusively by upsertRatings.
    // Sending rating:null here would wipe ratings set by the separate ratings run.
    const batch = productos.slice(i, i + BATCH_SIZE).map(({ rating: _r, ...rest }) => rest);

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

// Partial upsert — only buybox/dynamic fields, never touches titulo, marca, img_url.
// Use for products where Keepa returned no title, to preserve existing metadata.
export async function upsertBuyboxOnly(
  productos: ProductoRecord[],
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<void> {
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=merge-duplicates",
  };

  for (let i = 0; i < productos.length; i += BATCH_SIZE) {
    const batch = productos.slice(i, i + BATCH_SIZE).map(p => ({
      asin:                 p.asin,
      pais:                 p.pais,
      precio:               p.precio,
      precio_min:           p.precio_min,
      cambio_1d:            p.cambio_1d,
      es_fba:               p.es_fba,
      vendedor:             p.vendedor,
      tenemos:              p.tenemos,
      hay_buybox:           p.hay_buybox,
      // rating omitted — managed exclusively by upsertRatings
      oferta:               p.oferta,
      ranking_subcategoria: p.ranking_subcategoria,
      categoria_id:         p.categoria_id,
      categoria_nombre:     p.categoria_nombre,
      ranking_pct:          p.ranking_pct,
      vendedor_nombre:      p.vendedor_nombre,
      updated_at:           p.updated_at,
      // titulo, marca, img_url deliberately omitted → DB keeps existing values
    }));

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
        `Supabase buybox-only upsert failed: ${res.status} ${text.slice(0, 300)}`
      );
    }
  }
}

export async function deleteProductosByAsins(
  asins: string[],
  pais: string,
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<void> {
  if (asins.length === 0) return;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const asinList = asins.join(",");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?pais=eq.${pais}&asin=in.(${asinList})`,
    { method: "DELETE", headers }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase delete failed for ${pais} ASINs: ${res.status} ${text.slice(0, 300)}`
    );
  }
}

export async function deleteProductosByCountry(
  pais: string,
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<void> {
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?pais=eq.${pais}`,
    { method: "DELETE", headers }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase delete failed for ${pais}: ${res.status} ${text.slice(0, 300)}`
    );
  }
}

export async function getCachedCategories(
  pairs: { catId: number; domain: string }[],
  supabaseUrl: string,
  supabaseKey: string
): Promise<Map<string, CategoryInfo>> {
  const cache = new Map<string, CategoryInfo>();
  if (pairs.length === 0) return cache;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const catIds = [...new Set(pairs.map((p) => p.catId))].join(",");

  const res = await fetch(
    `${supabaseUrl}/rest/v1/categorias_cache?cat_id=in.(${catIds})&updated_at=gte.${cutoff}&select=*`,
    { headers }
  );

  if (!res.ok) return cache;

  const rows = (await res.json()) as {
    cat_id: number;
    domain: string;
    nombre: string;
    total: number;
  }[];

  for (const row of rows) {
    cache.set(`${row.cat_id}:${row.domain}`, {
      catId: row.cat_id,
      domain: row.domain,
      nombre: row.nombre,
      total: row.total,
    });
  }

  return cache;
}

export async function upsertCategorias(
  categorias: CategoryInfo[],
  supabaseUrl: string,
  supabaseKey: string
): Promise<void> {
  if (categorias.length === 0) return;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=merge-duplicates",
  };

  const rows = categorias.map((c) => ({
    cat_id: c.catId,
    domain: c.domain,
    nombre: c.nombre,
    total: c.total,
    updated_at: new Date().toISOString(),
  }));

  const res = await fetch(
    `${supabaseUrl}/rest/v1/categorias_cache?on_conflict=cat_id,domain`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(rows),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(
      `Category cache upsert warning: ${res.status} ${text.slice(0, 200)}`
    );
  }
}

export async function getCachedSellers(
  sellerIds: string[],
  supabaseUrl: string,
  supabaseKey: string
): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  if (sellerIds.length === 0) return cache;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };

  const ids = sellerIds.map((id) => `"${id}"`).join(",");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/vendedores_cache?seller_id=in.(${ids})&select=seller_id,nombre`,
    { headers }
  );

  if (!res.ok) return cache;

  const rows = (await res.json()) as { seller_id: string; nombre: string }[];
  for (const row of rows) {
    cache.set(row.seller_id, row.nombre);
  }
  return cache;
}

export async function upsertVendedores(
  vendedores: { sellerId: string; nombre: string }[],
  supabaseUrl: string,
  supabaseKey: string
): Promise<void> {
  if (vendedores.length === 0) return;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=merge-duplicates",
  };

  const rows = vendedores.map((v) => ({
    seller_id: v.sellerId,
    nombre: v.nombre,
    updated_at: new Date().toISOString(),
  }));

  const res = await fetch(
    `${supabaseUrl}/rest/v1/vendedores_cache?on_conflict=seller_id`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(rows),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`Seller cache upsert warning: ${res.status} ${text.slice(0, 200)}`);
  }
}

// Returns the set of ASINs that already have a row with a non-null titulo for the given country.
// Used to skip skeleton-row creation in upsertBuyboxOnly.
export async function getAsinsWithTitulo(
  asins: string[],
  pais: string,
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<Set<string>> {
  if (asins.length === 0) return new Set();
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const asinList = asins.map(a => `"${a}"`).join(",");
  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?select=asin&pais=eq.${pais}&asin=in.(${asinList})&titulo=not.is.null`,
    { headers }
  );
  if (!res.ok) return new Set();
  const rows = await res.json() as { asin: string }[];
  return new Set(rows.map(r => r.asin));
}

// Partial upsert — updates only the rating column, preserving all other fields.
export async function upsertRatings(
  ratings: { asin: string; pais: string; rating: number | null }[],
  supabaseUrl: string,
  supabaseKey: string,
  table = "productos"
): Promise<void> {
  if (ratings.length === 0) return;

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=merge-duplicates",
  };

  for (let i = 0; i < ratings.length; i += BATCH_SIZE) {
    const batch = ratings.slice(i, i + BATCH_SIZE);
    const res = await fetch(
      `${supabaseUrl}/rest/v1/${table}?on_conflict=asin,pais`,
      { method: "POST", headers, body: JSON.stringify(batch) }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supabase ratings upsert failed: ${res.status} ${text.slice(0, 300)}`);
    }
  }
}

// Deletes every row from the given table. Used to start fresh before a single-ASIN test.
export async function clearAllProductos(url: string, key: string, table: string): Promise<void> {
  const res = await fetch(`${url}/rest/v1/${table}?asin=not.is.null`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`clearAllProductos failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

// Reads the current batch number from the batch_state table (defaults to 1 if not found).
export async function getBatchState(url: string, key: string): Promise<number> {
  const res = await fetch(
    `${url}/rest/v1/batch_state?key=eq.current_batch&select=value`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) return 1;
  const rows = await res.json() as { value: number }[];
  return rows?.[0]?.value ?? 1;
}

// Saves the current batch number to the batch_state table.
export async function setBatchState(value: number, url: string, key: string): Promise<void> {
  await fetch(`${url}/rest/v1/batch_state?key=eq.current_batch`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
}
