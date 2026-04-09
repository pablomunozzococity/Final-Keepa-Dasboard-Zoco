import type { ProductoRecord } from "./keepa-client.js";
import type { CategoryInfo } from "./category-client.js";

const BATCH_SIZE = 500;

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
